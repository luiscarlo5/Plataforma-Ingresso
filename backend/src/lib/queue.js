// RABBITMQ - Desacoplamento assíncrono (substitui o SNS/SQS da AWS).
//
// Topologia (declarada de forma idempotente por quem conecta):
//
//   API --(fila padrão)-------------------------> banner.tasks ---------> worker (redimensiona o banner)
//   API --> exchange "order.events" (fanout) --+-> tickets.tasks -------> worker (gera o PDF)
//                                              +-> notifications.tasks -> worker (envia o e-mail)
//
//   O fanout do pedido faz o papel do tópico SNS: UM evento PEDIDO_CONFIRMADO, duas filas independentes.
//   Cada fila de trabalho tem uma DLQ (exchange "dlx"): recebe mensagens ilegíveis ou que o worker rejeitou.
//
// Tentativas: o worker devolve "false" para tentar de novo; a mensagem é republicada na mesma fila com o
// cabeçalho x-attempt + 1 (o limite de tentativas está no worker).
const amqp = require('amqplib');

const ORDER_EXCHANGE = 'order.events';
const DLX = 'dlx';
const RETRY_DELAY_MS = 2000;

// kind -> fila de trabalho
const QUEUES = {
  banner: 'banner.tasks',
  ticket: 'tickets.tasks',
  notification: 'notifications.tasks'
};
const dlqName = (kind) => `${QUEUES[kind]}.dlq`;

let connection = null;
let channel = null;
let connecting = null;
const closeListeners = new Set();

// O worker usa isto para se reinscrever nas filas depois que a conexão cai e volta.
const onClose = (fn) => { closeListeners.add(fn); };

const brokerUrl = () => process.env.RABBITMQ_URL;
const isConfigured = () => !!brokerUrl();

async function assertTopology(ch) {
  await ch.assertExchange(DLX, 'direct', { durable: true });
  await ch.assertExchange(ORDER_EXCHANGE, 'fanout', { durable: true });
  for (const kind of Object.keys(QUEUES)) {
    await ch.assertQueue(dlqName(kind), { durable: true });
    await ch.bindQueue(dlqName(kind), DLX, kind);
    await ch.assertQueue(QUEUES[kind], {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DLX, 'x-dead-letter-routing-key': kind }
    });
  }
  // O pedido confirmado chega às DUAS filas (PDF e e-mail)
  await ch.bindQueue(QUEUES.ticket, ORDER_EXCHANGE, '');
  await ch.bindQueue(QUEUES.notification, ORDER_EXCHANGE, '');
}

function resetConnection() {
  connection = null;
  channel = null;
}

// Conexão única e preguiçosa; se cair, a próxima chamada reconecta.
async function getChannel() {
  if (channel) return channel;
  if (!isConfigured()) {
    throw new Error('RabbitMQ não configurado: defina RABBITMQ_URL (ex.: amqp://usuario:senha@rabbitmq:5672).');
  }
  if (!connecting) {
    connecting = (async () => {
      const conn = await amqp.connect(brokerUrl());
      conn.on('error', (err) => console.warn('[RabbitMQ] Erro de conexão:', err.message));
      conn.on('close', () => {
        console.warn('[RabbitMQ] Conexão encerrada; reconecta na próxima operação.');
        resetConnection();
        for (const fn of closeListeners) {
          try { fn(); } catch (e) { console.warn('[RabbitMQ] Erro em listener de close:', e.message); }
        }
      });
      const ch = await conn.createConfirmChannel();
      ch.on('error', (err) => console.warn('[RabbitMQ] Erro no canal:', err.message));
      await assertTopology(ch);
      connection = conn;
      channel = ch;
      console.log('[RabbitMQ] Conectado e filas declaradas.');
      return ch;
    })().finally(() => { connecting = null; });
  }
  return connecting;
}

// Conecta (com novas tentativas) no boot. A API e o worker não funcionam sem o broker.
async function connect({ attempts = 30, delayMs = 2000 } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await getChannel();
    } catch (err) {
      lastError = err;
      if (!isConfigured()) break;
      console.warn(`[RabbitMQ] Tentativa ${i}/${attempts} falhou: ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// Publica e espera a confirmação do broker (a mensagem é persistente e a fila é durável).
function publishConfirmed(ch, exchange, routingKey, message, headers = {}) {
  const content = Buffer.from(JSON.stringify(message));
  const options = { persistent: true, contentType: 'application/json', headers };
  return new Promise((resolve, reject) => {
    ch.publish(exchange, routingKey, content, options, (err) => (err ? reject(err) : resolve()));
  });
}

// ---------- Produtor (usado pela API) ----------
async function publishTask(taskPayload) {
  const message = { type: 'RESCALE_BANNER', ...taskPayload, enqueuedAt: new Date().toISOString() };
  const ch = await getChannel();
  await publishConfirmed(ch, '', QUEUES.banner, message);
  return { provider: 'RabbitMQ (fila banner.tasks)', enqueued: true };
}

// Evento PEDIDO_CONFIRMADO: vai para o exchange fanout e chega às filas de PDF e de e-mail.
async function publishOrderConfirmed(payload) {
  const message = { type: 'ORDER_CONFIRMED', ...payload, publishedAt: new Date().toISOString() };
  const ch = await getChannel();
  await publishConfirmed(ch, ORDER_EXCHANGE, '', message);
  return { provider: 'RabbitMQ (fanout order.events -> tickets.tasks + notifications.tasks)' };
}

// Pede (de novo) só o PDF de um pedido, direto na fila de ingressos, sem reenviar o e-mail.
async function requestTicketPdf(payload) {
  const message = { type: 'ORDER_CONFIRMED', ...payload, regenerated: true, publishedAt: new Date().toISOString() };
  const ch = await getChannel();
  await publishConfirmed(ch, '', QUEUES.ticket, message);
  return { provider: 'RabbitMQ (fila tickets.tasks)' };
}

// ---------- Consumidor (usado pelo worker) ----------
const attemptOf = (msg) => Number(msg.properties.headers?.['x-attempt'] || 1);

// Resolve a mensagem conforme o resultado do handler: true = ack; false = tenta de novo (até o worker desistir).
async function settle(ch, kind, msg, data, handler) {
  const attempt = attemptOf(msg);
  let done;
  try {
    done = await handler(data, { receiveCount: attempt });
  } catch (err) {
    console.error(`[Worker RabbitMQ] Handler de ${kind} lançou erro; mensagem vai para a DLQ:`, err.message);
    ch.nack(msg, false, false);
    return false;
  }
  if (done) {
    ch.ack(msg);
    return true;
  }
  // Nova tentativa: republica com x-attempt + 1 depois de uma pequena pausa e só então confirma a original
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  try {
    await publishConfirmed(ch, '', QUEUES[kind], data, { 'x-attempt': attempt + 1 });
    ch.ack(msg);
  } catch (err) {
    console.warn(`[Worker RabbitMQ] Não foi possível republicar (${kind}); devolve à fila:`, err.message);
    ch.nack(msg, false, true);
  }
  return false;
}

function parse(ch, kind, msg) {
  try {
    return JSON.parse(msg.content.toString('utf8'));
  } catch (err) {
    console.warn(`[Worker RabbitMQ] Mensagem ilegível em ${QUEUES[kind]} enviada para a DLQ:`, err.message);
    ch.nack(msg, false, false);
    return null;
  }
}

// Consome continuamente uma fila (worker em produção). handler(data, { receiveCount }) -> Promise<boolean>.
async function consume(kind, handler, { prefetch = 5 } = {}) {
  const ch = await getChannel();
  await ch.prefetch(prefetch);
  await ch.consume(QUEUES[kind], (msg) => {
    if (!msg) return; // consumidor cancelado pelo broker
    const data = parse(ch, kind, msg);
    if (data) settle(ch, kind, msg, data, handler).catch((e) => console.error('[Worker RabbitMQ] Erro:', e.message));
  });
  console.log(`[Worker RabbitMQ] Consumindo ${QUEUES[kind]}`);
}

// Esvazia uma fila uma vez (worker --once e testes). Retorna quantas mensagens foram processadas.
async function drain(kind, handler) {
  const ch = await getChannel();
  let processed = 0;
  for (;;) {
    const msg = await ch.get(QUEUES[kind], { noAck: false });
    if (!msg) return processed;
    const data = parse(ch, kind, msg);
    if (!data) continue;
    await settle(ch, kind, msg, data, handler);
    processed++;
  }
}

// Usado pelos testes para descartar mensagens pendentes de uma fila
async function purge(kind) {
  const ch = await getChannel();
  await ch.purgeQueue(QUEUES[kind]);
}

// Tamanho das filas e das DLQs (usado no /health)
async function stats() {
  const ch = await getChannel();
  const out = {};
  for (const kind of Object.keys(QUEUES)) {
    out[QUEUES[kind]] = (await ch.checkQueue(QUEUES[kind])).messageCount;
    out[dlqName(kind)] = (await ch.checkQueue(dlqName(kind))).messageCount;
  }
  return out;
}

async function close() {
  const conn = connection;
  resetConnection();
  if (conn) await conn.close().catch(() => {});
}

module.exports = {
  QUEUES,
  isConfigured,
  onClose,
  connect,
  publishTask,
  publishOrderConfirmed,
  requestTicketPdf,
  consume,
  drain,
  purge,
  stats,
  close
};
