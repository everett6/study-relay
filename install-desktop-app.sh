#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "${DIR}/study-relay-app.sh"
mkdir -p "${HOME}/.local/share/applications"
cp "${DIR}/study-relay.desktop" "${HOME}/.local/share/applications/study-relay.desktop"
echo "Installed ${HOME}/.local/share/applications/study-relay.desktop"
