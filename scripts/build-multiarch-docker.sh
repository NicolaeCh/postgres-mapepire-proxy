#!/usr/bin/env bash
set -euo pipefail
IMAGE="${IMAGE:-postgres-mapepire-proxy:0.1.15}"
docker buildx build \
  --platform linux/amd64,linux/ppc64le \
  -t "$IMAGE" \
  --push .
