# Ksinito en producción (Coolify, Dokploy, docker run…).
# Los datos viven en MySQL: configura DATABASE_URL (y DATABASE_SSL=1 si tu proveedor
# exige TLS). La app crea las tablas de db/schema.sql al arrancar.
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY db ./db

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
