#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

USE_LOCAL=0
COMPOSE_EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --local) USE_LOCAL=1 ;;
    *) COMPOSE_EXTRA_ARGS+=("$arg") ;;
  esac
done

wait_for_port() {
  local host=$1 port=$2 tries=${3:-50}
  local i
  for ((i = 0; i < tries; i++)); do
    if (echo >/dev/tcp/"$host"/"$port") 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

run_local_stack() {
  if ! command -v node >/dev/null 2>&1; then
    echo "error: Docker is not available and 'node' was not found." >&2
    echo "Install Docker, or install Node.js 22+ and use this script again (mock API + Vite)." >&2
    exit 1
  fi

  if [[ "${COMPOSE_EXTRA_ARGS[*]:-}" == *"-d"* ]]; then
    echo "note: detached (-d) only applies to Docker; running mock API + Vite in the foreground." >&2
  fi

  echo "Docker not found — starting mock API (port 8080) and Vite (port 5173)."
  echo "Open http://localhost:5173  (API: http://localhost:8080)"
  echo ""

  MOCK_PID=""
  cleanup() {
    if [[ -n "${MOCK_PID}" ]] && kill -0 "${MOCK_PID}" 2>/dev/null; then
      kill "${MOCK_PID}" 2>/dev/null || true
      wait "${MOCK_PID}" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT INT TERM HUP

  node "${ROOT}/mock-backend.js" &
  MOCK_PID=$!

  if ! wait_for_port 127.0.0.1 8080 75; then
    echo "error: mock API did not open port 8080 (need Node.js 22+ for node:sqlite)." >&2
    exit 1
  fi

  cd "${ROOT}/frontend"
  if [[ ! -d node_modules ]]; then
    npm install
  fi
  npm run dev
}

if [[ "${USE_LOCAL}" -eq 0 ]]; then
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    exec docker compose -f "${ROOT}/docker-compose.yml" up --build "${COMPOSE_EXTRA_ARGS[@]}"
  elif command -v docker-compose >/dev/null 2>&1; then
    exec docker-compose -f "${ROOT}/docker-compose.yml" up --build "${COMPOSE_EXTRA_ARGS[@]}"
  fi
fi

run_local_stack
