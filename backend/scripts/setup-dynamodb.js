const { CreateTableCommand, DescribeTableCommand, waitUntilTableExists } = require('@aws-sdk/client-dynamodb');
const { AWS_REGION, table, index, client } = require('../src/lib/dynamodb');

const attributes = ['id', 'pk', 'timestamp'].map((AttributeName) => ({ AttributeName, AttributeType: 'S' }));
const tableKey = [{ AttributeName: 'id', KeyType: 'HASH' }];
const indexKey = [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'timestamp', KeyType: 'RANGE' }];
const matches = (actual, expected) => actual?.length === expected.length
  && expected.every((item) => actual.some((candidate) => Object.keys(item).every((key) => candidate[key] === item[key])));

async function setup() {
  if (!client) throw new Error('Defina DYNAMODB_TABLE_NAME e AWS_REGION no .env.');

  const describe = new DescribeTableCommand({ TableName: table });
  let description;
  try {
    ({ Table: description } = await client.send(describe));
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') throw error;
    try {
      await client.send(new CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: attributes,
        KeySchema: tableKey,
        GlobalSecondaryIndexes: [{
          IndexName: index,
          KeySchema: indexKey,
          Projection: { ProjectionType: 'ALL' }
        }]
      }));
    } catch (createError) {
      if (createError.name !== 'ResourceInUseException') throw createError;
    }
  }

  if (description?.TableStatus !== 'ACTIVE') {
    await waitUntilTableExists({ client, maxWaitTime: 180, minDelay: 2, maxDelay: 8 }, { TableName: table });
    ({ Table: description } = await client.send(describe));
  }

  const auditIndex = description.GlobalSecondaryIndexes?.find((item) => item.IndexName === index);
  const auditAttributes = description.AttributeDefinitions?.filter(({ AttributeName }) =>
    attributes.some((item) => item.AttributeName === AttributeName));
  if (!matches(description.KeySchema, tableKey) || !matches(auditAttributes, attributes)
    || !matches(auditIndex?.KeySchema, indexKey) || auditIndex.Projection?.ProjectionType !== 'ALL') {
    throw new Error(`A tabela "${table}" tem esquema incompatível. Use uma tabela com id (String) e o índice ${index} (pk e timestamp, ambos String, projeção ALL).`);
  }
  if (auditIndex.IndexStatus !== 'ACTIVE') {
    throw new Error(`O índice "${index}" está ${auditIndex.IndexStatus}. Aguarde até ficar ACTIVE e execute o comando novamente.`);
  }
  console.log(`DynamoDB pronto na AWS: tabela=${table} região=${AWS_REGION} índice=${index}`);
}

setup().catch((error) => {
  console.error(`[DynamoDB] ${error.name}: ${error.message}`);
  process.exitCode = 1;
}).finally(() => client?.destroy());
