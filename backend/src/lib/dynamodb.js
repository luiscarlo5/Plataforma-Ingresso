const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const { AWS_REGION } = require('../config');

const table = process.env.DYNAMODB_TABLE_NAME?.trim();
const required = process.env.DYNAMODB_REQUIRED === 'true';
const index = 'by-time';
const partition = 'AUDIT';
const client = table ? new DynamoDBClient({
  region: AWS_REGION,
  ignoreConfiguredEndpointUrls: true
}) : null;
const documents = client && DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true }
});

module.exports = { AWS_REGION, table, required, index, partition, client, documents };
