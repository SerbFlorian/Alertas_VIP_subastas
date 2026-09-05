#!/usr/bin/env bash
# One-shot: aplica POSTGRES_PASSWORD del .env al rol existente (volumen ya creado).
# Uso (en el VPS):
#   cd ~/Alertas_VIP_subastas && bash scripts/rotate-postgres-password.sh
# No hace "source .env" (los cron con espacios/comas rompen bash).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Falta .env"
  exit 1
fi

env_get() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" .env | tail -n1 || true)"
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  local val="${line#*=}"
  # Quitar comillas envolventes
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  printf '%s' "$val"
}

POSTGRES_USER="$(env_get POSTGRES_USER)"
POSTGRES_PASSWORD="$(env_get POSTGRES_PASSWORD)"
POSTGRES_USER="${POSTGRES_USER:-postgres}"

if [[ -z "$POSTGRES_PASSWORD" ]]; then
  echo "POSTGRES_PASSWORD vacío en .env"
  exit 1
fi

OLD_PASS="${OLD_POSTGRES_PASSWORD:-postgrespassword}"

echo "Alterando password de postgres (conectando con password antigua)…"
docker compose exec -T -e PGPASSWORD="$OLD_PASS" postgres \
  psql -U "$POSTGRES_USER" -d postgres \
  -c "ALTER USER ${POSTGRES_USER} WITH PASSWORD '${POSTGRES_PASSWORD}';"

echo "OK. Ahora: docker compose up -d --force-recreate"
echo "Si falla el ALTER, exporta OLD_POSTGRES_PASSWORD=la_que_funcionaba y reintenta."
