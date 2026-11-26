// AMAZON DYNAMODB - Auditoria NoSQL de ações do CRUD (tipo da ação, dados manipulados e hora).
// Todo item recebe pk='AUDIT' para entrar no índice global "by-time" (pk + timestamp),
// permitindo listar os registros MAIS RECENTES em ordem (Scan não garante ordem).
//
// O mesmo código serve a dois destinos, só trocando variáveis de ambiente:
//   - DynamoDB Local (container do docker-compose): DYNAMODB_ENDPOINT=http://dynamodb:8000 e chaves de mentira;
//   - DynamoDB real na AWS: DYNAMODB_ENDPOINT vazio + AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN no Academy).
const crypto = require('node:crypto');
const { DynamoDBClient, DescribeTableCommand, CreateTableCommand, waitUntilTableExists } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { AWS_REGION } = require('../../config');

const AUDIT_PK = 'AUDIT';
const AUDIT_INDEX = 'by-time';
const TABLE = process.env.DYNAMODB_TABLE_NAME;
const ENDPOINT = process.env.DYNAMODB_ENDPOINT || undefined;

// Cliente "cru" (usado para criar/descrever a tabela) e cliente de documentos (usado nas gravações/consultas)
const rawClient = TABLE
  ? new DynamoDBClient({ region: AWS_REGION, ...(ENDPOINT && { endpoint: ENDPOINT }) })
  : null;
const dynamodb = rawClient
  ? DynamoDBDocumentClient.from(rawClient, { marshallOptions: { removeUndefinedValues: true } })
  : null;

const isConfigured = () => !!dynamodb;

// Cria a tabela (e o índice by-time) se ainda não existir. Idempotente; tenta de novo enquanto o DynamoDB sobe.
async function ensureTable({ attempts = 15, delayMs = 2000 } = {}) {
  if (!rawClient) return;
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      try {
        await rawClient.send(new DescribeTableCommand({ TableName: TABLE }));
      } catch (err) {
        if (err.name !== 'ResourceNotFoundException') throw err;
        await rawClient.send(new CreateTableCommand({
          TableName: TABLE,
          BillingMode: 'PAY_PER_REQUEST', // sem capacidade para dimensionar
          AttributeDefinitions: [
            { AttributeName: 'id', AttributeType: 'S' },
            { AttributeName: 'pk', AttributeType: 'S' },
            { AttributeName: 'timestamp', AttributeType: 'S' }
          ],
          KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
          GlobalSecondaryIndexes: [{
            IndexName: AUDIT_INDEX,
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'timestamp', KeyType: 'RANGE' }],
            Projection: { ProjectionType: 'ALL' }
          }]
        }));
        await waitUntilTableExists({ client: rawClient, maxWaitTime: 60 }, { TableName: TABLE });
        console.log(`[DynamoDB] Tabela "${TABLE}" criada (índice ${AUDIT_INDEX}).`);
        return;
      }
      console.log(`[DynamoDB] Tabela "${TABLE}" pronta${ENDPOINT ? ` (${ENDPOINT})` : ''}.`);
      return;
    } catch (err) {
      lastError = err;
      console.warn(`[DynamoDB] Tentativa ${i}/${attempts} falhou: ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

const localAuditLogs = []; // cópia em memória (usada sozinha em desenvolvimento)

// Registra uma ação. Nunca lança erro: falha de auditoria não derruba a operação principal.
async function logCrudAction(action, resource, payload) {
  const logEntry = {
    id: crypto.randomUUID(),
    pk: AUDIT_PK,
    action,
    resource,
    payload: JSON.stringify(payload),
    timestamp: new Date().toISOString()
  };

  localAuditLogs.unshift(logEntry);
  if (localAuditLogs.length > 100) localAuditLogs.pop();

  if (dynamodb) {
    try {
      await dynamodb.send(new PutCommand({ TableName: TABLE, Item: logEntry }));
    } catch (error) {
      console.warn('[DynamoDB] Erro ao salvar log de auditoria:', error.message);
    }
  }

  return logEntry;
}

async function listAuditLogs(limit = 100) {
  if (!dynamodb) return localAuditLogs;

  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: AUDIT_INDEX,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': AUDIT_PK },
      ScanIndexForward: false,
      Limit: limit
    }));
    return result.Items || [];
  } catch (err) {
    console.warn('[DynamoDB] Query no índice falhou, usando Scan ordenado:', err.message);
  }

  const items = [];
  let startKey;
  do {
    const page = await dynamodb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: startKey }));
    items.push(...(page.Items || []));
    startKey = page.LastEvaluatedKey;
  } while (startKey && items.length < 1000);
  items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return items.slice(0, limit);
}

module.exports = { isConfigured, ensureTable, logCrudAction, listAuditLogs, localAuditLogs };
