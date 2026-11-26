const db = require('./lib/db');
const { connectRedis } = require('./lib/cache');
const queue = require('./lib/queue');
const storage = require('./lib/storage');
const audit = require('./modules/audit/audit.model');

// Inicialização dos serviços: Redis (opcional), PostgreSQL, RabbitMQ, MinIO e DynamoDB (se configurado). Sem eles a API não sobe.
async function bootstrap() {
  await connectRedis();
  await db.ensureRelationalSchema();
  await queue.connect(); // RabbitMQ também é obrigatório: sem ele a API não publica tarefas
  await storage.ensureBucket(); // MinIO: cria o bucket e a política de leitura dos banners
  await audit.ensureTable(); // DynamoDB: cria a tabela de auditoria e o índice by-time (não faz nada se não configurado)
}

module.exports = bootstrap;
