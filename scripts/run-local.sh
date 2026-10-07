#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
# Nix supplies Node; never depend on a globally installed node binary.
# Help/version do not require credentials or a local env file.
case "${1-}" in
  --help|--version) exec nix develop "$root" -c node "$root/dist/index.js" "$@" ;;
  *) exec nix develop "$root" -c node --env-file="$root/.env" "$root/dist/index.js" "$@" ;;
esac
