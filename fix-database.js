import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔧 Limpando banco de dados de mensagens corrompidas...\n');

const db = new Database(path.join(__dirname, 'data', 'settings.db'));

// Conta mensagens antes
const beforeCount = db.prepare('SELECT COUNT(*) as total FROM conversations').get();
console.log(`📊 Total de mensagens antes: ${beforeCount.total}`);

// Remove mensagens com caracteres suspeitos (múltiplos scripts misturados)
const result = db.prepare(`
  DELETE FROM conversations 
  WHERE content GLOB '*[А-Яа-я]*[א-ת]*'
     OR content GLOB '*[א-ת]*[ا-ي]*'
     OR content GLOB '*Xbox*Switch*загруз*'
     OR content GLOB '*спів*파일*大发*'
     OR LENGTH(content) > 5000
`).run();

console.log(`🗑️  Mensagens removidas: ${result.changes}`);

// Conta mensagens depois
const afterCount = db.prepare('SELECT COUNT(*) as total FROM conversations').get();
console.log(`📊 Total de mensagens depois: ${afterCount.total}`);

// Mostra usuários afetados
const affectedUsers = db.prepare(`
  SELECT user_jid, COUNT(*) as msg_count 
  FROM conversations 
  GROUP BY user_jid
`).all();

console.log(`\n👥 Usuários com histórico:`);
affectedUsers.forEach(u => {
  console.log(`   - ${u.user_jid}: ${u.msg_count} mensagens`);
});

console.log('\n✅ Limpeza concluída!');
console.log('\n💡 Dica: Usuários podem enviar "/reset" para limpar seu histórico individual.');

db.close();

