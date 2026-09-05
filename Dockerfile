# syntax=docker/dockerfile:1
# Imagen Playwright (Node + Chromium ya incluidos). Runtime: pwuser (no root).
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app
USER root

# pg_dump/psql 16 (backups R2). Cache apt de BuildKit → rebuilds posteriores rápidos.
# NO reinstalar Chromium: ya viene en la imagen base (ahorra minutos).
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/postgresql-keyring.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/postgresql-keyring.gpg] https://apt.postgresql.org/pub/repos/apt jammy-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-16 curl; \
    apt-get purge -y --auto-remove gnupg; \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./

# Cache npm entre builds (prisma generate lo hace `npm run build`)
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci

COPY . .

RUN npm run build \
  && mkdir -p /app/logs \
  && chown -R pwuser:pwuser /app

USER pwuser

ENV NODE_ENV=production
EXPOSE 3002

CMD ["node", "dist/index.js"]
