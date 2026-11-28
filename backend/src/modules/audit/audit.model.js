// AMAZON DYNAMODB - Auditoria NoSQL de ações do CRUD (tipo da ação, dados manipulados e hora).
// Todo item recebe pk='AUDIT' para entrar no índice global "by-time" (pk + timestamp),
// permitindo listar os registros MAIS RECENTES em ordem (Scan não garante ordem).
const crypto = require('node:crypto');
const { PutCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { table, required, index, partition, documents } = require('../../lib/dynamodb');

const localAuditLogs = [];
let reachable = false;

function getStatus() {
  return { mode: documents || required ? 'aws' : 'memory', reachable, required };
}

async function checkConnection() {
  if (!documents && required) {
    throw new Error('Defina DYNAMODB_TABLE_NAME quando DYNAMODB_REQUIRED=true.');
  }
  if (!documents) return;

  try {
    await listAuditLogs(1);
    console.log(`[DynamoDB] Consulta à tabela "${table}" confirmada na AWS.`);
  } catch (error) {
    if (required) {
      throw new Error(`DynamoDB: falha ao consultar a tabela "${table}": ${error.message}`, { cause: error });
    }
    console.warn('[DynamoDB] Auditoria indisponível:', error.message);
  }
}

// Registra uma ação. Nunca lança erro: falha de auditoria não derruba a operação principal.
async function logCrudAction(action, resource, payload) {
  const logEntry = {
    id: crypto.randomUUID(),
    pk: partition,
    action,
    resource,
    payload: JSON.stringify(payload),
    timestamp: new Date().toISOString()
  };

  if (documents) {
    try {
      await documents.send(new PutCommand({ TableName: table, Item: logEntry }));
    } catch (error) {
      console.warn('[DynamoDB] Erro ao salvar log de auditoria:', error.message);
    }
  } else {
    localAuditLogs.unshift(logEntry);
    if (localAuditLogs.length > 100) localAuditLogs.pop();
  }

  return logEntry;
}

async function listAuditLogs(limit = 100) {
  if (!documents) return localAuditLogs.slice(0, limit);

  try {
    const result = await documents.send(new QueryCommand({
      TableName: table,
      IndexName: index,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': partition },
      ScanIndexForward: false,
      Limit: limit
    }));
    reachable = true;
    return result.Items || [];
  } catch (error) {
    reachable = false;
    if (required || error.name !== 'ValidationException' || !error.message.includes(index)) {
      throw error;
    }
    console.warn('[DynamoDB] Índice ausente ou indisponível na tabela antiga, usando Scan:', error.message);
  }

  const items = [];
  let startKey;
  do {
    const page = await documents.send(new ScanCommand({ TableName: table, ExclusiveStartKey: startKey }));
    items.push(...(page.Items || []));
    startKey = page.LastEvaluatedKey;
  } while (startKey && items.length < 1000);
  reachable = true;
  items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return items.slice(0, limit);
}

module.exports = { logCrudAction, listAuditLogs, checkConnection, getStatus };
