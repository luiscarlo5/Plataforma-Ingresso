const db = require('./lib/db');
const { connectRedis } = require('./lib/cache');
const queue = require('./lib/queue');
const { ensureDirectories } = require('./lib/localStore');

// Inicialização dos serviços: Redis (opcional), PostgreSQL e RabbitMQ (obrigatórios: sem eles a API não sobe).
async function bootstrap() {
  ensureDirectories(); // uploads locais (temporário, até o MinIO)
  await connectRedis();
  await db.ensureRelationalSchema();
  await queue.connect(); // RabbitMQ também é obrigatório: sem ele a API não publica tarefas
}

module.exports = bootstrap;
