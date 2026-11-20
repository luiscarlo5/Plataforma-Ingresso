# Imagem única do backend: a API (server.js) e o worker (worker.js) usam esta mesma imagem;
# o docker-compose.yml troca só o `command` do worker.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# bookworm-slim (glibc): o binário pré-compilado do sharp funciona sem compilar nada
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Inclui o schema.sql, lido em runtime pelo src/lib/db.js
COPY . .
# Pastas graváveis (modo local de fila/uploads, até as fases MinIO/RabbitMQ) pertencem ao usuário não-root
RUN mkdir -p /data /app/uploads && chown -R node:node /data /app/uploads
USER node
EXPOSE 3000
CMD ["node", "server.js"]
