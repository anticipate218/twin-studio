#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ -x .venv/bin/python ]; then
  exec .venv/bin/python server.py --port "${TWIN_PORT:-8090}" --open "$@"
fi
exec python3 server.py --port "${TWIN_PORT:-8090}" --open "$@"
