import express from 'express';
import fetch from 'node-fetch';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import Database from 'better-sqlite3';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

dotenv.config();

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Garante que o diretório de dados exista em runtime (fora do Docker também)
try {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
} catch (e) {
  console.error('Erro ao criar diretório de dados:', e);
}

// ---------- Auth básico opcional para /admin ----------
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
function basicAuth(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASS) return next();
  const auth = req.headers.authorization || '';
  const [type, b64] = auth.split(' ');
  if (type === 'Basic' && b64) {
    const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
    if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="admin"');
  return res.status(401).send('Auth required');
}

// ---------- DB (SQLite) ----------
const db = new Database(path.join(__dirname, 'data', 'settings.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    system_prompt TEXT NOT NULL,
    temperature REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conversations_user_ts ON conversations(user_jid, ts DESC);
`);
db.prepare('INSERT OR IGNORE INTO settings (id, system_prompt, temperature) VALUES (1, ?, ?)').run(
  'Você é um assistente do WhatsApp. Responda com clareza e objetividade, em português.',
  0.7
);

const getSettings = () =>
  db.prepare('SELECT system_prompt, temperature FROM settings WHERE id = 1').get();
const updateSettings = (prompt, temperature) =>
  db.prepare('UPDATE settings SET system_prompt=?, temperature=? WHERE id=1').run(prompt, temperature);

// ----- Sanitização de texto -----
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  
  // Remove caracteres de controle problemáticos, mantém apenas UTF-8 válido
  let sanitized = text
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '') // Remove controle chars exceto \n e \t
    .replace(/[\uFFFE-\uFFFF]/g, ''); // Remove caracteres não válidos em UTF-16
  
  // Remove sequências estranhas de caracteres misturados (heurística)
  // Detecta padrões como múltiplos scripts misturados sem espaços
  const suspiciousPattern = /[\u0400-\u04FF][\u0590-\u05FF][\u0600-\u06FF]/;
  if (suspiciousPattern.test(sanitized)) {
    // Se detectar múltiplos scripts misturados, tenta limpar
    sanitized = sanitized.split(/\s+/).filter(word => {
      // Mantém palavras que são principalmente de um script
      const latin = (word.match(/[a-zA-Z]/g) || []).length;
      const cyrillic = (word.match(/[\u0400-\u04FF]/g) || []).length;
      const arabic = (word.match(/[\u0600-\u06FF]/g) || []).length;
      const hebrew = (word.match(/[\u0590-\u05FF]/g) || []).length;
      const asian = (word.match(/[\u4e00-\u9FFF\u3400-\u4DBF\uAC00-\uD7AF\u0E00-\u0E7F]/g) || []).length;
      
      const total = latin + cyrillic + arabic + hebrew + asian;
      if (total === 0) return true; // Sem caracteres especiais, mantém
      // Mantém se pelo menos 80% dos caracteres são de um único script
      const maxScript = Math.max(latin, cyrillic, arabic, hebrew, asian);
      return maxScript / total >= 0.8;
    }).join(' ');
  }
  
  // Limita tamanho máximo para evitar mensagens gigantes
  const MAX_LENGTH = 10000;
  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.substring(0, MAX_LENGTH) + '...[truncado]';
  }
  
  return sanitized.trim();
}

// ----- Conversas: memória por usuário -----
const insertMsgStmt = db.prepare(`
  INSERT INTO conversations (user_jid, role, content, ts) VALUES (?, ?, ?, ?)
`);
const selectRecentStmt = db.prepare(`
  SELECT role, content FROM conversations
  WHERE user_jid = ?
  ORDER BY ts DESC
  LIMIT ?
`);
const countStmt = db.prepare(`
  SELECT COUNT(*) AS c FROM conversations WHERE user_jid = ?
`);
const deleteOldStmt = db.prepare(`
  DELETE FROM conversations
  WHERE id IN (
    SELECT id FROM conversations
    WHERE user_jid = ?
    ORDER BY ts DESC
    LIMIT -1 OFFSET ?
  )
`);
const deleteAllStmt = db.prepare(`
  DELETE FROM conversations WHERE user_jid = ?
`);

function saveMessage(userJid, role, content) {
  const sanitized = sanitizeText(content);
  if (sanitized) {
    insertMsgStmt.run(userJid, role, sanitized, Date.now());
  }
}
function getRecentConversation(userJid, limit = 10) {
  const rows = selectRecentStmt.all(userJid, limit);
  // Sanitiza as mensagens recuperadas do histórico
  return rows.map(row => ({
    role: row.role,
    content: sanitizeText(row.content)
  })).reverse(); // devolve em ordem cronológica crescente
}
function trimConversation(userJid, keep = 10) {
  const { c } = countStmt.get(userJid);
  if (c > keep) deleteOldStmt.run(userJid, keep);
}
function resetConversation(userJid) {
  deleteAllStmt.run(userJid);
}

// ---------- LLM ----------
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'openai').toLowerCase();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1';

// Limites e controle de latência/conciso
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 10);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 600); // Aumentado para permitir respostas completas
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 15000);
const MAX_CHARS = Number(process.env.MAX_CHARS || 1000); // Limite razoável para WhatsApp
const CONCISE_HINT = process.env.CONCISE_HINT || 'Responda de forma clara e objetiva em português. Mantenha as respostas concisas mas completas (máximo 3-4 frases). Se mencionar links, forneça a URL completa.';
const LINKS_MAX = Number(process.env.LINKS_MAX || 5);
const MAIN_LINK = process.env.MAIN_LINK || 'https://cravodasorte.net';

function enforceConciseness(text) {
  if (!text || typeof text !== 'string') return text;
  
  // Apenas limita o tamanho máximo sem cortar sentenças no meio
  let result = text.trim();
  
  // Se exceder o limite, tenta cortar em uma quebra de frase natural
  if (result.length > MAX_CHARS) {
    const truncated = result.substring(0, MAX_CHARS);
    // Procura pelo último ponto final, exclamação ou interrogação
    const lastBreak = Math.max(
      truncated.lastIndexOf('.'),
      truncated.lastIndexOf('!'),
      truncated.lastIndexOf('?')
    );
    
    if (lastBreak > MAX_CHARS * 0.7) {
      // Se encontrou uma quebra natural em pelo menos 70% do texto, usa ela
      result = truncated.substring(0, lastBreak + 1).trim();
    } else {
      // Senão, corta no espaço mais próximo
      const lastSpace = truncated.lastIndexOf(' ');
      result = truncated.substring(0, lastSpace > 0 ? lastSpace : MAX_CHARS).trim() + '…';
    }
  }
  
  return result;
}

// Quando houver links na resposta, normaliza para uma lista curta e limpa
function formatLinksIfPresent(text) {
  if (!text || typeof text !== 'string') return text;

  const links = [];

  function inferLinkLabel(url) {
    const u = String(url).toLowerCase();
    if (/(\.mp4|\.mov|\.m4v)$/.test(u) || u.includes('video')) return 'Vídeo tutorial';
    if (u.includes('pix')) return 'Cadastro Pix';
    if (u.includes('cadastro') || u.includes('signup') || u.includes('register')) return 'Cadastro';
    if (u.includes('apk') || u.includes('android')) return 'App Android';
    if (u.includes('ios') || u.includes('iphone') || u.includes('testflight') || u.includes('ipa')) return 'App iOS';
    if (u.includes('ajuda') || u.includes('help') || u.includes('suporte') || u.includes('faq')) return 'Ajuda';
    return 'Link útil';
  }

  // Captura [título](url)
  const mdRegex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = mdRegex.exec(text)) !== null) {
    const title = (m[1] || '').trim();
    const url = m[2];
    links.push({ title, url });
  }

  // Captura URLs soltas
  const urlRegex = /(https?:\/\/[^\s)]+)(?![^\[]*\))/g;
  let u;
  while ((u = urlRegex.exec(text)) !== null) {
    const url = u[1];
    if (!links.some(l => l.url === url)) links.push({ title: null, url });
  }

  if (links.length === 0) return text;

  const max = Math.min(links.length, LINKS_MAX);
  const lines = links.slice(0, max).map((l, i) => {
    const label = l.title && l.title.length > 2 ? l.title : inferLinkLabel(l.url);
    return `${i + 1}. ${label}: ${l.url}`;
  });
  return lines.join('\n');
}

async function askLLMWithMemory(userJid, userMessage) {
  const { system_prompt, temperature } = getSettings();

  // histórico curto (ex.: 10 turns - pode ajustar)
  const history = getRecentConversation(userJid, HISTORY_LIMIT);

  const messages = [
    { role: 'system', content: system_prompt },
    { role: 'system', content: CONCISE_HINT },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage }
  ];

  if (LLM_PROVIDER === 'ollama') {
    try {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          stream: false,
          options: { temperature: Number(temperature), num_predict: MAX_TOKENS }
        }),
        signal: controller.signal
      });
      clearTimeout(to);
      if (!res.ok) {
        const text = await res.text();
        console.error('Ollama error:', res.status, text);
        return 'Desculpe, tive um problema ao gerar a resposta.';
      }
      const data = await res.json();
      const rawReply = data?.message?.content?.trim() || data?.response?.trim() || 'Desculpe, não consegui gerar uma resposta agora.';
      console.log('[Ollama] Raw reply length:', rawReply.length);
      const sanitized = sanitizeText(rawReply);
      console.log('[Ollama] Sanitized reply length:', sanitized.length);
      return enforceConciseness(formatLinksIfPresent(sanitized));
    } catch (e) {
      if (e?.name === 'AbortError') {
        return 'Desculpe, estou demorando para responder. Tente novamente com uma pergunta mais objetiva.';
      }
      console.error('Ollama fetch error:', e);
      return 'Desculpe, tive um problema ao gerar a resposta.';
    }
  }

  // default: OpenAI
  if (!OPENAI_API_KEY) {
    return 'O servidor não está configurado com a OPENAI_API_KEY. Tente novamente mais tarde.';
  }

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: Number(temperature),
      max_tokens: MAX_TOKENS,
      messages
    }),
    signal: controller.signal
  });
  clearTimeout(to);

  if (!res.ok) {
    const text = await res.text();
    console.error('OpenAI error:', res.status, text);
    return 'Desculpe, tive um problema ao gerar a resposta.';
  }

  const data = await res.json();
  const rawReply = data.choices?.[0]?.message?.content?.trim() || 'Desculpe, não consegui gerar uma resposta agora.';
  console.log('[OpenAI] Raw reply length:', rawReply.length);
  console.log('[OpenAI] First 200 chars:', rawReply.substring(0, 200));
  const sanitized = sanitizeText(rawReply);
  console.log('[OpenAI] Sanitized reply length:', sanitized.length);
  return enforceConciseness(formatLinksIfPresent(sanitized));
}

// ---------- WhatsApp via Baileys ----------
let sock;
let latestQR = null;         // guarda o QR atual (string)
let connected = false;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'data', 'baileys-auth'));
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // QR via HTTP
    browser: ['Coolify', 'Chrome', '1.0.0'],
    logger: pino({ level: process.env.BAILEYS_LOG_LEVEL || 'info' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      latestQR = qr;
      connected = false;
      console.log('QR atualizado — acesse /admin para escanear.');
    }
    if (connection === 'open') {
      connected = true;
      latestQR = null;
      console.log('Conectado ao WhatsApp Web ✅');
    }
    if (connection === 'close') {
      connected = false;
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log('Conexão fechada', reason, 'reconectar:', shouldReconnect);
      if (shouldReconnect) startWhatsApp();
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages?.[0];
    if (!msg || !msg.key?.remoteJid || msg.key.fromMe) return;

    const userJid = msg.key.remoteJid; // ex: 5511999999999@s.whatsapp.net
    const rawText =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      '';
    
    const text = sanitizeText(rawText);

    if (!text) {
      await sock.sendMessage(userJid, { text: 'No momento, respondo apenas mensagens de texto.' });
      return;
    }

    // Comandos especiais
    if (text.trim().toLowerCase() === '/reset') {
      resetConversation(userJid);
      await sock.sendMessage(userJid, { text: 'Memória desta conversa foi apagada. Podemos recomeçar! ✨' });
      return;
    }
    
    if (text.trim().toLowerCase() === '/debug') {
      const history = getRecentConversation(userJid, 5);
      const info = `Debug Info:\n- Histórico: ${history.length} mensagens\n- Modelo: ${OPENAI_MODEL}\n- Max Tokens: ${MAX_TOKENS}\n- Provider: ${LLM_PROVIDER}`;
      await sock.sendMessage(userJid, { text: info });
      return;
    }

    // fluxo normal
    try {
      // salva a mensagem do usuário antes (para contexto em chamadas futuras)
      saveMessage(userJid, 'user', text);

      let typingInterval;
      try {
        await sock.sendPresenceUpdate('composing', userJid);
      } catch {}
      typingInterval = setInterval(() => {
        sock.sendPresenceUpdate('composing', userJid).catch(() => {});
      }, 7000);

      // Regras rápidas: respostas curtas, explicativas, com link
      const t = text.trim().toLowerCase();
      const saidYes = /\b(sim|já joguei|ja joguei)\b/.test(t) && t.length <= 25;
      const saidNever = /(nunca\s*joguei|nao\s*joguei|não\s*joguei|primeira\s*vez)/.test(t);
      if (saidYes) {
        const quick = `Muito bem! Estou te enviando o link para iniciar suas jogadas: ${MAIN_LINK}`;
        saveMessage(userJid, 'assistant', quick);
        await sock.sendMessage(userJid, { text: quick });
        clearInterval(typingInterval);
        try { await sock.sendPresenceUpdate('paused', userJid); } catch {}
        return;
      }
      if (saidNever) {
        const quick = `Entendo perfeitamente! Aqui está o link para se cadastrar e começar: ${MAIN_LINK}. Qualquer dúvida, pode falar comigo por aqui.`;
        saveMessage(userJid, 'assistant', quick);
        await sock.sendMessage(userJid, { text: quick });
        clearInterval(typingInterval);
        try { await sock.sendPresenceUpdate('paused', userJid); } catch {}
        return;
      }

      const reply = await askLLMWithMemory(userJid, text);

      // salva resposta do assistente (já sanitizada pela função)
      const sanitizedReply = sanitizeText(reply);
      saveMessage(userJid, 'assistant', sanitizedReply);

      // mantém só os últimos N registros
      trimConversation(userJid, 20); // mantém ~20 mensagens (10 pares)
      await sock.sendMessage(userJid, { text: sanitizedReply });
      clearInterval(typingInterval);
      try { await sock.sendPresenceUpdate('paused', userJid); } catch {}
    } catch (e) {
      console.error('Atendimento error:', e);
      await sock.sendMessage(userJid, { text: 'Tive um problema ao responder agora. Tente novamente.' });
    }
  });
}

// ---------- Admin API ----------
app.get('/api/settings', basicAuth, (req, res) => {
  res.json(getSettings());
});

app.post('/api/settings', basicAuth, (req, res) => {
  const { system_prompt, temperature } = req.body || {};
  const t = Number(temperature);
  if (typeof system_prompt !== 'string' || Number.isNaN(t) || t < 0 || t > 2) {
    return res.status(400).json({ error: 'Parâmetros inválidos. Temperatura deve ser 0..2.' });
  }
  updateSettings(system_prompt, t);
  res.json({ ok: true });
});

// ---------- Diagnóstico LLM ----------
app.get('/api/llm', basicAuth, (req, res) => {
  res.json({
    provider: LLM_PROVIDER,
    openai: {
      configured: Boolean(OPENAI_API_KEY),
      model: OPENAI_MODEL
    },
    ollama: {
      host: OLLAMA_HOST,
      model: OLLAMA_MODEL
    },
    limits: {
      HISTORY_LIMIT,
      MAX_TOKENS,
      LLM_TIMEOUT_MS,
      REPLY_SENTENCES_LIMIT
    }
  });
});

app.post('/api/test-llm', basicAuth, async (req, res) => {
  const { prompt } = req.body || {};
  const userPrompt = typeof prompt === 'string' && prompt.trim() ? prompt.trim() : 'Responda apenas: OK';

  // Monta mensagens mínimas para teste
  const messages = [
    { role: 'system', content: 'Teste de diagnóstico do servidor. Responda de forma breve.' },
    { role: 'user', content: userPrompt }
  ];

  try {
    if (LLM_PROVIDER === 'ollama') {
      const controller = new AbortController();
      const to = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
      const r = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          messages,
          stream: false,
          options: { temperature: 0.2, num_predict: MAX_TOKENS }
        }),
        signal: controller.signal
      });
      clearTimeout(to);
      if (!r.ok) {
        const text = await r.text();
        return res.status(502).json({ ok: false, provider: 'ollama', error: text });
      }
      const data = await r.json();
      const reply = data?.message?.content?.trim() || data?.response?.trim() || '';
      return res.json({ ok: true, provider: 'ollama', model: OLLAMA_MODEL, reply: enforceConciseness(reply) });
    }

    // default OpenAI
    if (!OPENAI_API_KEY) return res.status(400).json({ ok: false, error: 'OPENAI_API_KEY ausente', provider: 'openai' });
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.2,
        max_tokens: MAX_TOKENS,
        messages
      }),
      signal: controller.signal
    });
    clearTimeout(to);
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ ok: false, provider: 'openai', error: text });
    }
    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content?.trim() || '';
    return res.json({ ok: true, provider: 'openai', model: OPENAI_MODEL, reply: enforceConciseness(reply) });
  } catch (e) {
    if (e?.name === 'AbortError') {
      return res.status(504).json({ ok: false, error: 'Tempo esgotado', provider: LLM_PROVIDER });
    }
    console.error('test-llm error:', e);
    return res.status(500).json({ ok: false, error: 'Falha interna no teste', provider: LLM_PROVIDER });
  }
});

// GET helper para teste rápido via navegador: /api/test-llm?q=...
app.get('/api/test-llm', basicAuth, async (req, res) => {
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : 'Responda apenas: OK';
  try {
    const r = await fetch(`${req.protocol}://${req.get('host')}/api/test-llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: req.headers.authorization || '' },
      body: JSON.stringify({ prompt: q })
    });
    const data = await r.text();
    res.type('application/json').send(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Falha ao redirecionar para POST /api/test-llm' });
  }
});

// ---------- QR por HTTP ----------
app.get('/admin/qr.png', basicAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!latestQR) return res.status(204).end(); // sem QR no momento
  try {
    const png = await QRCode.toBuffer(latestQR, { margin: 1, width: 300 });
    res.type('png').send(png);
  } catch (e) {
    console.error('QR render error:', e);
    res.sendStatus(500);
  }
});

app.get('/admin/status', basicAuth, (req, res) => {
  res.json({ connected, hasQR: Boolean(latestQR) });
});

// ---------- Frontend estático ----------
app.use('/admin', basicAuth, express.static(path.join(__dirname, 'public')));

// ---------- Health ----------
app.get('/health', (_, res) => res.json({ ok: true, connected }));

// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
startWhatsApp().catch(e => console.error('Erro ao iniciar WhatsApp:', e));
