# Ksinito en producción (Coolify, Dokploy, docker run…).
# Los datos (cuentas, créditos, fotos y el secreto JWT) viven en /data:
# monta ahí un volumen persistente o se borrarán en cada deploy.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public

# /data pertenece a "node" para que un volumen nuevo herede esos permisos.
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
