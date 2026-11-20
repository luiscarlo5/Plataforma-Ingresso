// MINIO - Armazenamento de arquivos (banners, miniaturas e PDFs dos ingressos).
// O MinIO fala o protocolo S3, então usamos o @aws-sdk/client-s3 apontando para o nosso endpoint.
//
// Um único bucket, dois prefixos:
//   banners/*  -> PÚBLICO (leitura anônima por política do bucket). O navegador lê pelo nginx em /files/banners/...
//   tickets/*  -> PRIVADO. Só a API lê, e entrega o PDF depois de validar o token do dono do ingresso.
const crypto = require('node:crypto');
const {
  S3Client, PutObjectCommand, GetObjectCommand,
  HeadBucketCommand, CreateBucketCommand, PutBucketPolicyCommand
} = require('@aws-sdk/client-s3');

const ENDPOINT = process.env.MINIO_ENDPOINT;
const BUCKET = process.env.MINIO_BUCKET || 'stadium-files';

// Somente imagens são aceitas como banner; a extensão vem do tipo MIME, nunca do nome enviado.
const IMAGE_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

const isConfigured = () => !!(ENDPOINT && process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY);

let client = null;
function s3() {
  if (!isConfigured()) {
    throw new Error('MinIO não configurado: defina MINIO_ENDPOINT, MINIO_ACCESS_KEY e MINIO_SECRET_KEY.');
  }
  if (!client) {
    client = new S3Client({
      endpoint: ENDPOINT,
      region: 'us-east-1', // o MinIO ignora a região, mas o SDK exige uma
      forcePathStyle: true, // http://minio:9000/<bucket>/<chave> (não <bucket>.minio:9000)
      credentials: { accessKeyId: process.env.MINIO_ACCESS_KEY, secretAccessKey: process.env.MINIO_SECRET_KEY },
      // Versões novas do SDK mandam cabeçalhos de checksum que nem todo MinIO aceita
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });
  }
  return client;
}

const isNotFound = (err) => err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchBucket';

// Cria o bucket se não existir e aplica a política: leitura anônima SÓ de banners/*. Idempotente.
async function ensureBucket({ attempts = 15, delayMs = 2000 } = {}) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      try {
        await s3().send(new HeadBucketCommand({ Bucket: BUCKET }));
      } catch (err) {
        if (!isNotFound(err)) throw err;
        await s3().send(new CreateBucketCommand({ Bucket: BUCKET }));
      }
      await s3().send(new PutBucketPolicyCommand({
        Bucket: BUCKET,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [{
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${BUCKET}/banners/*`]
          }]
        })
      }));
      console.log(`[MinIO] Bucket "${BUCKET}" pronto (banners/* público, tickets/* privado).`);
      return;
    } catch (err) {
      lastError = err;
      if (!isConfigured()) break;
      console.warn(`[MinIO] Tentativa ${i}/${attempts} falhou: ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

// URL pública relativa: o nginx repassa /files/banners/* para o bucket (mesma origem do site).
const publicUrl = (key) => `/files/${key}`;

async function put(subfolder, fileName, buffer, contentType) {
  const key = `${subfolder}/${fileName}`;
  await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: contentType }));
  return { url: publicUrl(key), bucket: BUCKET, key, fileName };
}

// Banner original enviado pelo administrador (multer file) -> banners/raw/
function saveBanner(file) {
  const fileName = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${IMAGE_TYPES[file.mimetype] || '.jpg'}`;
  return put('banners/raw', fileName, file.buffer, file.mimetype);
}

// Thumbnail gerado pelo worker -> banners/processed/. Retorna a URL.
async function saveThumbnail(buffer) {
  const fileName = `thumb-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
  const saved = await put('banners/processed', fileName, buffer, 'image/jpeg');
  return saved.url;
}

// Obtém os bytes da imagem descrita por uma tarefa da fila.
async function loadImage(task) {
  if (task.imageBase64) {
    return Buffer.from(task.imageBase64, 'base64');
  }

  if (task.s3Bucket && task.s3Key) {
    const obj = await s3().send(new GetObjectCommand({ Bucket: task.s3Bucket, Key: task.s3Key }));
    return Buffer.from(await obj.Body.transformToByteArray());
  }

  if (task.bannerUrl && task.bannerUrl.startsWith('http')) {
    const res = await fetch(task.bannerUrl);
    if (!res.ok) throw new Error(`Download do banner falhou (HTTP ${res.status}).`);
    return Buffer.from(await res.arrayBuffer());
  }

  return null;
}

// ---------- Ingressos em PDF (PRIVADOS) ----------
// Ficam em tickets/, fora do prefixo público banners/*: ninguém lê sem passar pela API, que confere o token.
const ticketKey = (orderId) => `tickets/${orderId}.pdf`;

async function saveTicket(orderId, buffer) {
  await s3().send(new PutObjectCommand({ Bucket: BUCKET, Key: ticketKey(orderId), Body: buffer, ContentType: 'application/pdf' }));
}

// Lê o PDF do MinIO para a API repassar ao cliente. Retorna { stream, length } ou null se não existir.
async function getTicket(orderId) {
  try {
    const obj = await s3().send(new GetObjectCommand({ Bucket: BUCKET, Key: ticketKey(orderId) }));
    return { stream: obj.Body, length: obj.ContentLength };
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

module.exports = {
  BUCKET, IMAGE_TYPES, isConfigured, ensureBucket,
  saveBanner, saveThumbnail, loadImage, saveTicket, getTicket
};
