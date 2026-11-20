// Fila local de tarefas em arquivo (substitui SNS/SQS até a migração para o RabbitMQ).
// Os DADOS (usuários, jogos, pedidos, reservas) ficam só no PostgreSQL: nada disso é gravado em arquivo.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, QUEUE_FILE, UPLOADS_DIR } = require('../config');

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(UPLOADS_DIR, 'banners', 'raw'), { recursive: true });
  fs.mkdirSync(path.join(UPLOADS_DIR, 'banners', 'processed'), { recursive: true });

  if (!fs.existsSync(QUEUE_FILE)) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

function pushLocalTask(message) {
  ensureDirectories();
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  queue.push(message);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
}

function pullLocalTask() {
  if (!fs.existsSync(QUEUE_FILE)) return null;
  try {
    const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (Array.isArray(queue) && queue.length > 0) {
      const task = queue.shift();
      fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
      return task;
    }
  } catch (err) {
    console.warn('[Fila local] Erro ao ler fila:', err.message);
  }
  return null;
}

module.exports = { ensureDirectories, pushLocalTask, pullLocalTask };
