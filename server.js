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
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';

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
  insertMsgStmt.run(userJid, role, content, Date.now());
}
function getRecentConversation(userJid, limit = 10) {
  const rows = selectRecentStmt.all(userJid, limit);
  return rows.reverse(); // devolve em ordem cronológica crescente
}
function trimConversation(userJid, keep = 10) {
  const { c } = countStmt.get(userJid);
  if (c > keep) deleteOldStmt.run(userJid, keep);
}
function resetConversation(userJid) {
  deleteAllStmt.run(userJid);
}

// ---------- LLM ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function askLLMWithMemory(userJid, userMessage) {
  if (!OPENAI_API_KEY) {
    return 'O servidor não está configurado com a OPENAI_API_KEY. Tente novamente mais tarde.';
  }
  const { system_prompt, temperature } = getSettings();

  // histórico curto (ex.: 10 turns - pode ajustar)
  const history = getRecentConversation(userJid, 10);

  const messages = [
    { role: 'system', content: system_prompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage }
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: Number(temperature),
      messages
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error('LLM error:', res.status, text);
    return 'Desculpe, tive um problema ao gerar a resposta.';
  }

  const data = await res.json();
  const reply = data.choices?.[0]?.message?.content?.trim() || 'Desculpe, não consegui gerar uma resposta agora.';
  return reply;
}

// ---------- WhatsApp via Baileys ----------
let sock;
let latestQR = null;         // guarda o QR atual (string)
let connected = false;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'data', 'baileys-auth'));

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // QR via HTTP
    logger: pino({ level: 'info' })
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
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      '';

    if (!text) {
      await sock.sendMessage(userJid, { text: 'No momento, respondo apenas mensagens de texto.' });
      return;
    }

    // Comando /reset
    if (text.trim().toLowerCase() === '/reset') {
      resetConversation(userJid);
      await sock.sendMessage(userJid, { text: 'Memória desta conversa foi apagada. Podemos recomeçar! ✨' });
      return;
    }

    // fluxo normal
    try {
      // salva a mensagem do usuário antes (para contexto em chamadas futuras)
      saveMessage(userJid, 'user', text);

      const reply = await askLLMWithMemory(userJid, text);

      // salva resposta do assistente
      saveMessage(userJid, 'assistant', reply);

      // mantém só os últimos N registros
      trimConversation(userJid, 20); // mantém ~20 mensagens (10 pares)
      await sock.sendMessage(userJid, { text: reply });
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
