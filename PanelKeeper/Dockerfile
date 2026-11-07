FROM node:22-bookworm-slim AS base

WORKDIR /app

COPY package*.json ./

FROM base AS dependencies

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --omit=dev --no-audit --no-fund

FROM base AS final

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tzdata ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p data

ENV PORT=7001 \
    DB_PATH=/app/data/panelkeeper.db \
    QC_DB_PATH=/app/data/panelkeeper_qc.db \
    LOG_PATH=/app/data/manager_history.log

COPY --from=dependencies /app/node_modules ./node_modules
COPY . .

EXPOSE 7001

CMD ["node", "server.js"]