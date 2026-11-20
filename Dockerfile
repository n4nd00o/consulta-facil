# Consulta Fácil — imagem de produção (sem dependências externas: só o Node.js 24)
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY test ./test

# Banco SQLite persistente em /app/data (montado como volume no docker-compose)
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/config > /dev/null || exit 1

CMD ["node", "--no-warnings", "src/server.js"]
