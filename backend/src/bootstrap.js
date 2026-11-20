const db = require('./lib/db');
const { connectRedis } = require('./lib/cache');
const { ensureDirectories } = require('./lib/localStore');

// Inicialização dos serviços: Redis (opcional) e esquema do PostgreSQL (obrigatório: sem ele a API não sobe).
async function bootstrap() {
  ensureDirectories(); // fila e uploads locais (temporário, até RabbitMQ/MinIO)
  await connectRedis();
  await db.ensureRelationalSchema();
}

module.exports = bootstrap;
