const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const { ADMIN_PASSWORD, PORT } = require('../src/config');
const { AWS_REGION, table, index, documents, client } = require('../src/lib/dynamodb');

async function request(path, { token, body, method = 'GET' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method, headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`${method} ${path} retornou HTTP ${response.status}.`);
  return response.json();
}

async function verify() {
  assert.ok(documents, 'Defina DYNAMODB_TABLE_NAME no container.');
  const health = await request('/health');
  assert.deepEqual(health.auditStorage, { mode: 'aws', reachable: true, required: true },
    'Inicie o backend com DYNAMODB_REQUIRED=true e a tabela AWS acessível.');

  const { token } = await request('/auth/admin', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  const { event } = await request('/events', {
    method: 'POST',
    token,
    body: {
      teamHome: 'Verificação DynamoDB', teamAway: 'Evento de teste', stadium: 'Auditoria',
      date: new Date(Date.now() + 86400000).toISOString(), price: 1, available: 0
    }
  });

  try {
    let log;
    // O índice secundário é atualizado de forma assíncrona pela AWS.
    for (let attempt = 0; attempt < 20 && !log; attempt++) {
      if (attempt) await delay(1000);
      const logs = await request('/audit-logs', { token });
      log = logs.find((entry) => entry.action === 'CREATE' && entry.resource === 'event'
        && JSON.parse(entry.payload).id === event.id);
    }
    assert.ok(log, `O painel não encontrou o registro CREATE do evento ${event.id}.`);

    const { Item } = await documents.send(new GetCommand({
      TableName: table, Key: { id: log.id }, ConsistentRead: true
    }));
    assert.deepEqual(Item, log, 'O registro devolvido pela API precisa corresponder ao item da tabela AWS.');
    console.log(JSON.stringify({
      resultado: 'Gravação e consulta confirmadas na AWS',
      regiao: AWS_REGION, tabela: table, indice: index, evento: event.id,
      auditoria: log.id, acao: log.action, data: log.timestamp
    }, null, 2));
  } finally {
    await request(`/events/${event.id}`, { method: 'DELETE', token }).catch((error) => {
      console.warn(`Remova o evento de teste ${event.id} no painel: ${error.message}`);
    });
  }
}

verify().catch((error) => {
  console.error(`[DynamoDB] ${error.name}: ${error.message}`);
  process.exitCode = 1;
}).finally(() => client?.destroy());
