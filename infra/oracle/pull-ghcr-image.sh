#!/usr/bin/env bash
# Authenticated GHCR pull on Oracle; never persist the short-lived release token.
# The password arrives only on stdin from the GitHub release runner.
set -euo pipefail

APP_DIR="${1:?app directory required}"
TAG="${2:?image tag required}"
GHCR_USER="${3:?registry username required}"
COMPOSE_FILE="${4:-compose.micro-app.yml}"
case "$COMPOSE_FILE" in
  compose.micro-app.yml | compose.oracle.yml) ;;
  *) echo "Unsupported Trevra Compose file" >&2; exit 2 ;;
esac
if [[ ! "$TAG" =~ ^[a-zA-Z0-9_.-]+$ ]]; then
  echo 'Invalid Trevra image tag' >&2
  exit 2
fi

# Docker writes its temporary authorization only under this disposable config.
# Both success and failure remove it; the image stays in the shared Docker cache.
CONFIG_DIR="$(mktemp -d)"
chmod 700 "$CONFIG_DIR"
trap 'rm -rf -- "$CONFIG_DIR"' EXIT
export DOCKER_CONFIG="$CONFIG_DIR"
docker login ghcr.io --username "$GHCR_USER" --password-stdin >/dev/null
cd "$APP_DIR"
TREVRA_IMAGE_TAG="$TAG" docker compose --env-file .env.oracle -f "$COMPOSE_FILE" pull
