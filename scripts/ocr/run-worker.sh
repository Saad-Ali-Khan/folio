#!/usr/bin/env bash
set -euo pipefail
cd "$1"
if [[ ! -x .folio-ocr/venv-linux/bin/python ]]; then
  echo 'Local OCR environment missing. Run npm run ocr:trial first.' >&2
  exit 78
fi
export PADDLE_HOME="$PWD/.folio-ocr/cache/paddle"
export PADDLE_PDX_CACHE_HOME="$PWD/.folio-ocr/cache/paddlex"
exec .folio-ocr/venv-linux/bin/python -u scripts/ocr/worker.py
