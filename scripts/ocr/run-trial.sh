#!/usr/bin/env bash
set -euo pipefail
cd "$1"
mkdir -p .folio-ocr/tools
export UV_INSTALL_DIR="$PWD/.folio-ocr/tools"
export UV_NO_MODIFY_PATH=1
export UV_PYTHON_INSTALL_DIR="$PWD/.folio-ocr/python"
export UV_CACHE_DIR="$PWD/.folio-ocr/cache/uv"
if [[ ! -x .folio-ocr/tools/uv ]]; then
  curl --fail --location --silent --show-error https://astral.sh/uv/0.13.9/install.sh -o .folio-ocr/tools/install-uv.sh
  sh .folio-ocr/tools/install-uv.sh
fi
if [[ ! -x .folio-ocr/venv-linux/bin/python ]]; then
  .folio-ocr/tools/uv venv --python 3.12 .folio-ocr/venv-linux
fi
.folio-ocr/tools/uv pip install --python .folio-ocr/venv-linux/bin/python -r scripts/ocr/requirements.txt
.folio-ocr/tools/uv pip freeze --python .folio-ocr/venv-linux/bin/python > .folio-ocr/installed-requirements.txt
export PADDLE_HOME="$PWD/.folio-ocr/cache/paddle"
export PADDLE_PDX_CACHE_HOME="$PWD/.folio-ocr/cache/paddlex"
if [[ "${2:-mobile}" == "geometry" ]]; then
  .folio-ocr/venv-linux/bin/python scripts/ocr/geometry_benchmark.py
else
  .folio-ocr/venv-linux/bin/python scripts/ocr/paddle_benchmark.py --profile "${2:-mobile}"
fi
