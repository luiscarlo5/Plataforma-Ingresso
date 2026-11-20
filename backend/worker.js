// Worker desacoplado: consome as filas do RabbitMQ e executa o trabalho pesado fora da API.
//  - banner.tasks         -> redimensiona a imagem do jogo (sharp) e grava o thumbnail;
//  - tickets.tasks        -> gera o PDF do ingresso com QR code e grava (privado);
//  - notifications.tasks  -> envia o e-mail de confirmação ao cliente.
// As duas últimas recebem o MESMO evento PEDIDO_CONFIRMADO, publicado uma vez no exchange fanout (order.events).
// Também devolve ao estoque as reservas de checkout vencidas.
// Reaproveita as mesmas camadas da API (src/lib e src/modules/*/model).
const sharp = require('sharp');
const Event = require('./src/modules/events/event.model');
const Order = require('./src/modules/orders/order.model');
const Reservation = require('./src/modules/reservations/reservation.model');
const { logCrudAction } = require('./src/modules/audit/audit.model');
const { generateTicketPdf } = require('./src/modules/tickets/ticket.pdf');
const { signDownloadToken } = require('./src/modules/tickets/ticket.token');
const { invalidateCache, closeRedis } = require('./src/lib/cache');
const storage = require('./src/lib/storage');
const queue = require('./src/lib/queue');
const notifier = require('./src/lib/notifier');
const { putMetric } = require('./src/lib/metrics');
const db = require('./src/lib/db');
const { APP_PUBLIC_URL } = require('./src/config');

// Após N tentativas a tarefa é dada como perdida e a mensagem sai da fila
// (a DLQ de cada fila captura mensagens ilegíveis ou que o handler rejeitou com erro).
const MAX_ATTEMPTS = 3;
const SWEEP_INTERVAL_MS = 15000;

// Erro sem chance de sucesso em nova tentativa (ex.: imagem corrompida).
class PermanentError extends Error {}

const money = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Executa a tarefa. Retorna true quando a mensagem pode sair da fila (sucesso ou falha definitiva)
// e false para tentar de novo. `onGiveUp` registra a falha definitiva.
async function runTask(label, receiveCount, fn, onGiveUp) {
  try {
    await fn();
    return true;
  } catch (error) {
    console.error(`[Worker] ${label} falhou (tentativa ${receiveCount}):`, error.message);
    if (error instanceof PermanentError || receiveCount >= MAX_ATTEMPTS) {
      try {
        await onGiveUp(error);
        return true; // falha definitiva registrada: descarta a mensagem em vez de reprocessar por 24h
      } catch (markError) {
        console.error(`[Worker] Não foi possível registrar a falha de ${label}:`, markError.message);
      }
    }
    return false;
  }
}

// ---------- 1. Banner do jogo ----------
async function processMessage(task, { receiveCount = 1 } = {}) {
  console.log(`[Worker] Banner do evento ${task.eventId} (tentativa ${receiveCount})`);
  return runTask(`banner ${task.eventId}`, receiveCount, async () => {
    const imageBuffer = await storage.loadImage(task);
    if (!imageBuffer) throw new PermanentError('Não foi possível obter a imagem do banner.');

    let resizedBuffer;
    try {
      resizedBuffer = await sharp(imageBuffer)
        .resize({ width: 400, height: 260, fit: 'cover', position: 'center' })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();
    } catch (sharpError) {
      throw new PermanentError(`Imagem inválida: ${sharpError.message}`);
    }

    const thumbnailUrl = await storage.saveThumbnail(resizedBuffer); // MinIO
    await Event.update(task.eventId, { thumbnailUrl, processingStatus: 'completed' }); // PostgreSQL
    await invalidateCache(['events:list', `events:${task.eventId}`]); // Redis
    await logCrudAction('RESCALE_BANNER_COMPLETED', 'banner_processing', { // DynamoDB
      eventId: task.eventId, originalUrl: task.bannerUrl || null, thumbnailUrl
    });
    console.log(`[Worker] Thumbnail pronto para o evento ${task.eventId}: ${thumbnailUrl}`);
  }, async (error) => {
    await Event.update(task.eventId, { processingStatus: 'failed' });
    await invalidateCache(['events:list', `events:${task.eventId}`]);
    await logCrudAction('RESCALE_BANNER_FAILED', 'banner_processing', {
      eventId: task.eventId, reason: error.message, attempts: receiveCount
    });
  });
}

// ---------- 2. PDF do ingresso (assinante 1 do PEDIDO_CONFIRMADO) ----------
async function processTicket(task, { receiveCount = 1 } = {}) {
  const { order, event } = task;
  console.log(`[Worker] PDF do ingresso ${order?.id} (tentativa ${receiveCount})`);
  return runTask(`PDF ${order?.id}`, receiveCount, async () => {
    if (!order?.id) throw new PermanentError('Mensagem sem pedido.');
    const pdf = await generateTicketPdf(order, event);
    await storage.saveTicket(order.id, pdf); // MinIO (prefixo privado tickets/)
    await Order.setTicketStatus(order.id, 'ready'); // PostgreSQL
    await logCrudAction('TICKET_PDF_GENERATED', 'ticket', { orderId: order.id, bytes: pdf.length });
    putMetric('TicketPdfsGenerated');
  }, async (error) => {
    if (order?.id) await Order.setTicketStatus(order.id, 'failed'); // permite pedir de novo pela tela
    await logCrudAction('TICKET_PDF_FAILED', 'ticket', { orderId: order?.id, reason: error.message, attempts: receiveCount });
  });
}

function confirmationEmail(order, event) {
  const teams = event ? `${event.teamHome} x ${event.teamAway}` : order.eventName;
  const date = event ? new Date(event.date).toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Fortaleza' }) : '';
  const link = `${APP_PUBLIC_URL}/tickets/${encodeURIComponent(order.id)}/download?token=${signDownloadToken(order.id)}`;
  return {
    subject: `Ingresso confirmado: ${teams}`,
    text: [
      `Olá, ${order.customerName}!`,
      '',
      'Sua compra foi confirmada. Bom jogo!',
      '',
      `Jogo: ${teams}`,
      event ? `Estádio: ${event.stadium}` : null,
      date ? `Data: ${date}` : null,
      `Setor: ${order.sectorName || 'Arquibancada'}`,
      `Quantidade: ${order.quantity}`,
      `Total pago: ${money(order.total)}`,
      `Código localizador: ${order.id}`,
      '',
      'Baixe o seu ingresso (PDF com QR code):',
      link,
      '',
      `Você também encontra seus ingressos em ${APP_PUBLIC_URL}/meus-ingressos.html`
    ].filter((l) => l !== null).join('\n')
  };
}

// ---------- 3. E-mail ao cliente (assinante 2 do PEDIDO_CONFIRMADO) ----------
async function processNotification(task, { receiveCount = 1 } = {}) {
  const { order, event } = task;
  console.log(`[Worker] E-mail do pedido ${order?.id} (tentativa ${receiveCount})`);
  return runTask(`e-mail ${order?.id}`, receiveCount, async () => {
    if (!order?.id || !order.customerEmail) throw new PermanentError('Mensagem sem pedido ou sem e-mail.');
    const { subject, text } = confirmationEmail(order, event);
    const sent = await notifier.sendEmail({ to: order.customerEmail, subject, text });
    await logCrudAction('EMAIL_SENT', 'notification', { orderId: order.id, to: order.customerEmail, provider: sent.provider });
    putMetric('EmailsSent');
  }, async (error) => {
    await logCrudAction('EMAIL_FAILED', 'notification', { orderId: order?.id, reason: error.message, attempts: receiveCount });
  });
}

const HANDLERS = { banner: processMessage, ticket: processTicket, notification: processNotification };

// Devolve ao estoque as reservas de checkout vencidas
async function sweepReservations() {
  try {
    const eventIds = await Reservation.releaseExpired();
    if (eventIds.length) {
      await invalidateCache(['events:list', ...eventIds.map((id) => `events:${id}`)]);
      console.log(`[Worker] Reservas vencidas devolvidas ao estoque (jogos: ${eventIds.join(', ')})`);
      putMetric('ReservationSweeps');
    }
    return eventIds;
  } catch (error) {
    console.warn('[Worker] Falha ao liberar reservas vencidas:', error.message);
    return [];
  }
}

// Processa uma vez tudo que está nas filas (worker --once e testes) e limpa as reservas vencidas.
async function runOnce() {
  let processedCount = 0;
  for (const kind of Object.keys(HANDLERS)) {
    processedCount += await queue.drain(kind, HANDLERS[kind]);
  }
  await sweepReservations();
  return processedCount;
}

let isRunning = true;
let sweepTimer = null;
let resubscribing = false;

// Um consumidor por fila: o broker entrega as mensagens assim que chegam (sem polling)
async function subscribeAll() {
  await queue.connect();
  for (const kind of Object.keys(HANDLERS)) {
    await queue.consume(kind, HANDLERS[kind]);
  }
}

async function resubscribe() {
  if (!isRunning || resubscribing) return;
  resubscribing = true;
  try {
    while (isRunning) {
      try {
        await subscribeAll();
        console.log('[Worker] Reinscrito nas filas do RabbitMQ.');
        return;
      } catch (err) {
        console.warn('[Worker] RabbitMQ indisponível, nova tentativa em 3s:', err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  } finally {
    resubscribing = false;
  }
}

async function startLoop() {
  console.log('========================================================');
  console.log('🚀 Worker desacoplado iniciado');
  console.log(`🐰 RabbitMQ: ${queue.isConfigured() ? 'configurado' : 'NÃO CONFIGURADO'}`);
  console.log(`🗄️ PostgreSQL: ${db.isConfigured() ? 'Conectado' : 'NÃO CONFIGURADO'}`);
  console.log(`📦 MinIO: ${storage.isConfigured() ? process.env.MINIO_ENDPOINT : 'NÃO CONFIGURADO'}`);
  console.log(`✉️ E-mail: ${notifier.isEnabled() ? 'Amazon SNS (e-mail)' : 'local (data/outbox)'}`);
  console.log('========================================================');

  if (!db.isConfigured() || !queue.isConfigured() || !storage.isConfigured()) {
    console.error('[Worker] PostgreSQL, RabbitMQ e MinIO são obrigatórios: defina DATABASE_URL, RABBITMQ_URL e MINIO_*. Encerrando.');
    process.exit(1);
  }

  await subscribeAll();
  // Se o RabbitMQ cair e voltar, a conexão é refeita e o worker precisa assinar as filas de novo
  queue.onClose(resubscribe);
  sweepTimer = setInterval(() => { sweepReservations(); }, SWEEP_INTERVAL_MS);
  await sweepReservations();
}

function stop() {
  console.log('\n[Worker] Finalizando worker de forma graciosa...');
  isRunning = false;
  if (sweepTimer) clearInterval(sweepTimer);
  Promise.allSettled([queue.close(), closeRedis()]).then(() => process.exit(0));
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

if (require.main === module) {
  const isOnce = process.argv.includes('--once');
  if (isOnce) {
    runOnce().then((count) => {
      console.log(`[Worker] Execução única finalizada. ${count} tarefas processadas.`);
      process.exit(0);
    });
  } else {
    startLoop().catch((err) => {
      console.error('[Worker] Falha fatal no loop do worker:', err);
      process.exit(1);
    });
  }
}

module.exports = {
  runOnce,
  processMessage,
  processTicket,
  processNotification,
  sweepReservations
};
