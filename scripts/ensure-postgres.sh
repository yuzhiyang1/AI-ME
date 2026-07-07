#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE"
  echo "Create .env from .env.example, or run 'make worktree-env' and use .env.worktree."
  exit 1
fi

set -a
# shellcheck disable=SC1090
. <(sed 's/\r$//' "$ENV_FILE")
set +a

POSTGRES_DB="${POSTGRES_DB:-multica}"
POSTGRES_USER="${POSTGRES_USER:-multica}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-multica}"
DATABASE_URL="${DATABASE_URL:-}"

export PGPASSWORD="$POSTGRES_PASSWORD"

db_host=""
db_port="${POSTGRES_PORT:-5432}"
db_name="$POSTGRES_DB"

parse_database_url() {
  local rest authority hostport path port_part

  rest="${DATABASE_URL#*://}"
  rest="${rest%%\?*}"
  authority="${rest%%/*}"
  path="${rest#*/}"

  if [ "$authority" = "$rest" ]; then
    path=""
  fi

  hostport="${authority##*@}"

  if [[ "$hostport" == \[* ]]; then
    db_host="${hostport#\[}"
    db_host="${db_host%%]*}"
    port_part="${hostport#*\]}"
    if [[ "$port_part" == :* ]] && [ -n "${port_part#:}" ]; then
      db_port="${port_part#:}"
    fi
  else
    db_host="${hostport%%:*}"
    if [[ "$hostport" == *:* ]] && [ -n "${hostport##*:}" ]; then
      db_port="${hostport##*:}"
    fi
  fi

  if [ -n "$path" ]; then
    db_name="${path%%/*}"
  fi
}

find_pg_isready() {
  local candidate

  if command -v pg_isready > /dev/null 2>&1; then
    command -v pg_isready
    return 0
  fi

  if command -v pg_isready.exe > /dev/null 2>&1; then
    command -v pg_isready.exe
    return 0
  fi

  for candidate in \
    "/d/program/PostgreSQL/17/bin/pg_isready.exe" \
    "/c/Program Files/PostgreSQL/17/bin/pg_isready.exe"; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

if [ -n "$DATABASE_URL" ]; then
  parse_database_url
fi

PG_ISREADY_BIN="$(find_pg_isready || true)"

is_local() {
  [ -z "$DATABASE_URL" ] || [ "$db_host" = "localhost" ] || [ "$db_host" = "127.0.0.1" ] || [ "$db_host" = "::1" ]
}

if is_local; then
  # ---------- Local: prefer an already-running PostgreSQL ----------
  # This lets Windows dev machines use a native PostgreSQL service instead of
  # requiring Docker for every checkout.
  if [ -n "$PG_ISREADY_BIN" ]; then
    echo "==> Checking local PostgreSQL at ${db_host:-localhost}:$db_port..."
    if [ -n "$DATABASE_URL" ]; then
      if "$PG_ISREADY_BIN" -d "$DATABASE_URL" > /dev/null 2>&1; then
        echo "✓ PostgreSQL ready (local: ${db_host:-localhost}:$db_port). Database: $db_name"
        exit 0
      fi
    elif "$PG_ISREADY_BIN" -h "${db_host:-localhost}" -p "$db_port" -U "$POSTGRES_USER" -d "$POSTGRES_DB" > /dev/null 2>&1; then
      echo "✓ PostgreSQL ready (local: ${db_host:-localhost}:$db_port). Database: $db_name"
      exit 0
    fi
  fi

  if ! command -v docker > /dev/null 2>&1; then
    echo "Local PostgreSQL is not reachable at ${db_host:-localhost}:$db_port, and Docker is not installed."
    echo "Start PostgreSQL or set DATABASE_URL to a reachable database."
    exit 1
  fi

  # ---------- Local fallback: use Docker ----------
  echo "==> Ensuring shared PostgreSQL container is running on localhost:$db_port..."
  docker compose up -d postgres

  echo "==> Waiting for PostgreSQL to be ready..."
  until docker compose exec -T postgres pg_isready -U "$POSTGRES_USER" -d postgres > /dev/null 2>&1; do
    sleep 1
  done

  echo "==> Ensuring database '$POSTGRES_DB' exists..."
  db_exists="$(docker compose exec -T postgres \
    psql -U "$POSTGRES_USER" -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = '$POSTGRES_DB'")"

  if [ "$db_exists" != "1" ]; then
    docker compose exec -T postgres \
      psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
      -c "CREATE DATABASE \"$POSTGRES_DB\"" \
      > /dev/null
  fi

  echo "✓ PostgreSQL ready (local Docker). Database: $POSTGRES_DB"
else
  # ---------- Remote: skip Docker, verify connectivity ----------
  echo "==> Remote database detected (host: $db_host). Skipping Docker."
  if [ -n "$PG_ISREADY_BIN" ]; then
    echo "==> Waiting for PostgreSQL at $db_host:$db_port to be ready..."
    until "$PG_ISREADY_BIN" -d "$DATABASE_URL" > /dev/null 2>&1; do
      sleep 1
    done
    echo "✓ PostgreSQL ready (remote: $db_host:$db_port). Database: $db_name"
  else
    echo "==> pg_isready not found. Skipping remote connectivity preflight."
    echo "✓ PostgreSQL configured (remote: $db_host:$db_port). Database: $db_name"
  fi
fi
