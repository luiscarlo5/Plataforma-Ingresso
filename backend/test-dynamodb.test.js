const test = require('node:test');
const assert = require('node:assert/strict');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');

process.env.DYNAMODB_TABLE_NAME = 'audit-test';
process.env.DYNAMODB_REQUIRED = 'true';
const audit = require('./src/modules/audit/audit.model');
const auditController = require('./src/modules/audit/audit.controller');

test('auditoria AWS consulta o índice, grava e recupera o log pelo SDK', async (t) => {
  const items = [];
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    assert.equal(command.input.TableName, 'audit-test');
    if (command instanceof PutCommand) {
      items.push(command.input.Item);
      return {};
    }
    assert.ok(command instanceof QueryCommand);
    assert.equal(command.input.IndexName, 'by-time');
    assert.equal(command.input.ExpressionAttributeValues[':pk'], 'AUDIT');
    return { Items: [...items] };
  });

  assert.equal(audit.getStatus().reachable, false);
  await audit.checkConnection();
  assert.deepEqual(audit.getStatus(), { mode: 'aws', reachable: true, required: true });

  const entry = await audit.logCrudAction('CREATE', 'event', { id: 'event-test' });
  assert.equal(JSON.parse(entry.payload).id, 'event-test');
  assert.deepEqual(await audit.listAuditLogs(), [entry]);
});

test('falha do DynamoDB impede a inicialização obrigatória e a rota responde 503', async (t) => {
  const denied = Object.assign(new Error('Acesso negado'), { name: 'AccessDeniedException' });
  const send = t.mock.method(DynamoDBDocumentClient.prototype, 'send', async () => { throw denied; });

  await assert.rejects(audit.checkConnection(), /falha ao consultar a tabela "audit-test"/);
  assert.equal(audit.getStatus().reachable, false);

  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  await auditController.list({}, res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.message, /falha ao consultar o DynamoDB/);
  assert.equal(send.mock.callCount(), 2);
});

test('o cliente escolhe o endpoint da AWS mesmo com override de endpoint no ambiente', async () => {
  const { client } = require('./src/lib/dynamodb');
  assert.ok(client instanceof DynamoDBClient);
  assert.equal(client.config.ignoreConfiguredEndpointUrls, true);
});
