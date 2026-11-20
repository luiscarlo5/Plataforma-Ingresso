// Pastas locais de uploads de banners (temporário, até a migração para o MinIO).
// Dados de negócio ficam no PostgreSQL e as filas no RabbitMQ: nada disso é gravado em arquivo.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR, UPLOADS_DIR } = require('../config');

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(UPLOADS_DIR, 'banners', 'raw'), { recursive: true });
  fs.mkdirSync(path.join(UPLOADS_DIR, 'banners', 'processed'), { recursive: true });
}

module.exports = { ensureDirectories };
