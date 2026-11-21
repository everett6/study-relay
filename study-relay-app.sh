#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${RELAY_PORT:-8000}"
URL="${RELAY_URL:-https://studyflow.tail1bc539.ts.net}"

# Prefer the live Pi 5 relay if reachable; otherwise start the local relay on :$PORT.
if ! curl -sf "${URL}/healthz" >/dev/null 2>&1; then
  URL="http://127.0.0.1:${PORT}"
  if command -v ollama >/dev/null 2>&1; then
    if ! curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
      export OLLAMA_CONTEXT_LENGTH="${LOCAL_LLM_CTX:-32768}"
      nohup ollama serve >/tmp/study-relay-ollama.log 2>&1 &
      for _ in $(seq 1 20); do
        curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1 && break
        sleep 0.3
      done
    fi
  fi
  if ! curl -sf "${URL}/healthz" >/dev/null 2>&1; then
    mkdir -p "${DIR}/server"
    (
      cd "${DIR}/server"
      export LOCAL_LLM_CTX="${LOCAL_LLM_CTX:-32768}"
      nohup "${DIR}/study-relay" >/tmp/study-relay.log 2>&1 &
    )
    for _ in $(seq 1 30); do
      curl -sf "${URL}/healthz" >/dev/null 2>&1 && break
      sleep 0.2
    done
  fi
fi

# 3. Open in a dedicated chromeless app window (or default browser).
for bin in google-chrome chromium chromium-browser; do
  if command -v "$bin" >/dev/null 2>&1; then
    exec "$bin" --app="${URL}" --enable-unsafe-webgpu --enable-features=Vulkan,WebGPU --ignore-gpu-blocklist
  fi
done

PW_CHROME="$(find "${HOME}/.cache/ms-playwright" -maxdepth 3 -name chrome -type f 2>/dev/null | head -n 1 || true)"
if [[ -n "${PW_CHROME}" ]]; then
  exec "${PW_CHROME}" --no-sandbox --ozone-platform=x11 --user-data-dir="${HOME}/.config/study-relay-chrome" \
    --app="${URL}" --enable-unsafe-webgpu --enable-features=Vulkan,WebGPU --ignore-gpu-blocklist
fi

exec xdg-open "${URL}"
