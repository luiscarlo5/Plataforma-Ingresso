const db = require('./lib/db');
const { connectRedis } = require('./lib/cache');
const queue = require('./lib/queue');
const storage = require('./lib/storage');
const { checkConnection } = require('./modules/audit/audit.model');

// Inicialização dos serviços: Redis (opcional), PostgreSQL, RabbitMQ e MinIO (obrigatórios: sem eles a API não sobe).
async function bootstrap() {
  await checkConnection();
  await connectRedis();
  await db.ensureRelationalSchema();
  await queue.connect(); // RabbitMQ também é obrigatório: sem ele a API não publica tarefas
  await storage.ensureBucket(); // MinIO: cria o bucket e a política de leitura dos banners
}

module.exports = bootstrap;
