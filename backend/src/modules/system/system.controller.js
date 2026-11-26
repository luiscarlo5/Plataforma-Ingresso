// CONTROLLER de sistema: healthcheck (usado pelo Compose e pelo painel admin) e carga de CPU para testes.
const os = require('node:os');
const { Worker } = require('node:worker_threads');

// GET /health - usado pelo healthcheck do Compose e pelo painel admin
function health(req, res) {
  res.json({
    status: 'ok',
    service: 'stadium-tickets-api',
    instance: {
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: process.uptime()
    },
    services: {
      postgres: !!(process.env.DATABASE_URL || process.env.DB_HOST),
      redis: !!(process.env.REDIS_HOST || process.env.REDIS_URL),
      dynamodb: !!process.env.DYNAMODB_TABLE_NAME,
      minio: !!process.env.MINIO_ENDPOINT,
      rabbitmq: !!process.env.RABBITMQ_URL
    }
  });
}

// Código executado em cada thread de carga: laço de CPU até o prazo.
const BURN_CODE = `
  const { workerData } = require('node:worker_threads');
  let x = 0;
  while (Date.now() < workerData.until) { x += Math.sqrt(Math.random() * 1000000); }
`;

// Threads de carga ativas. Limitamos ao dobro dos vCPUs para não sufocar a thread principal
// (que precisa responder ao /health) quando várias requisições /stress chegam juntas.
let activeBurners = 0;
const vcpus = Math.max(1, os.cpus().length);

// GET /stress (admin) - limite de 30s por requisição.
// Uma thread por vCPU, para ocupar todos os núcleos do container (um laço em uma única thread usaria só um).
// As threads rodam fora do event loop, então o /health continua respondendo.
function stress(req, res) {
  const requested = Number(req.query.duration);
  const durationMs = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 10000, 30000);
  const until = Date.now() + durationMs;

  const toSpawn = Math.max(0, Math.min(vcpus, vcpus * 2 - activeBurners));
  let pending = toSpawn;

  const finish = () => {
    res.json({
      message: `Carga de CPU executada por ${durationMs}ms`,
      instance: os.hostname(),
      threads: toSpawn
    });
  };

  if (toSpawn === 0) {
    // Já há carga suficiente rodando: apenas espera o prazo (a carga existente mantém a CPU alta).
    return void setTimeout(finish, durationMs);
  }

  activeBurners += toSpawn;
  for (let i = 0; i < toSpawn; i++) {
    const worker = new Worker(BURN_CODE, { eval: true, workerData: { until } });
    let done = false;
    const onEnd = () => {
      if (done) return;
      done = true;
      activeBurners -= 1;
      pending -= 1;
      if (pending === 0) finish();
    };
    worker.once('exit', onEnd);
    worker.once('error', onEnd);
  }
}

module.exports = { health, stress };
