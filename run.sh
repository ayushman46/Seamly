#!/usr/bin/env bash
# Start BowlNet: builds the web app (if needed) and serves everything on http://127.0.0.1:8000
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-$ROOT/.venv/bin/python}"
if [ ! -d "$ROOT/frontend/dist" ] || [ "${REBUILD:-0}" = "1" ]; then
  (cd "$ROOT/frontend" && { [ -d node_modules ] || pnpm install; } && pnpm build)
fi
(cd "$ROOT/backend" && "$PY" -m tools.download_models)
cd "$ROOT/backend"
exec "$PY" -m uvicorn bowlnet.api:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}"
