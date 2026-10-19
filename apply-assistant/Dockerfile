# apply-assistant: server-side store + API for the Apply Copilot extension.
# Built from the apply-assistant/ folder only; no upstream Job Ops code is copied in.
FROM node:24.14.0-slim

ENV NODE_ENV=production \
    APPLY_PORT=3006 \
    APPLY_DATA_DIR=/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY server/src ./server/src

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 3006

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.APPLY_PORT||3006)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings=ExperimentalWarning", "--import", "tsx", "server/src/index.ts"]
