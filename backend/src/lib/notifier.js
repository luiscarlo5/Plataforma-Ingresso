// E-MAIL AOS CLIENTES - caixa de saída local.
// Cada e-mail vira um arquivo .txt em DATA_DIR/outbox/ (no Compose, o volume "appdata", compartilhado pela API e pelo worker).
// A interface (subscribe/subscriptionStatus/sendEmail) foi mantida para que trocar por um servidor SMTP
// (ex.: MailHog) seja mudar só este arquivo.
const fs = require('node:fs');
const path = require('node:path');
const { DATA_DIR } = require('../config');

const OUTBOX = () => path.join(DATA_DIR, 'outbox');

const isEnabled = () => false; // nenhum provedor externo: sempre caixa de saída local

// Sem confirmação de assinatura: o cliente recebe os e-mails da própria conta.
async function subscribe() {
  return { status: 'local' };
}

async function subscriptionStatus() {
  return 'local';
}

async function sendEmail({ to, subject, text }) {
  fs.mkdirSync(OUTBOX(), { recursive: true });
  const file = path.join(OUTBOX(), `${Date.now()}-${to.replace(/[^a-z0-9@._-]/gi, '_')}.txt`);
  fs.writeFileSync(file, `Para: ${to}\nAssunto: ${subject}\n\n${text}\n`, 'utf8');
  return { provider: 'local-outbox', file };
}

module.exports = { isEnabled, subscribe, subscriptionStatus, sendEmail };
