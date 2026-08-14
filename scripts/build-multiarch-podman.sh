#!/usr/bin/env bash
set -euo pipefail
IMAGE="${IMAGE:-localhost/postgres-mapepire-proxy:0.1.26}"
MANIFEST="${MANIFEST:-$IMAGE}"

podman manifest rm "$MANIFEST" 2>/dev/null || true
podman manifest create "$MANIFEST"
podman build --platform linux/amd64   --manifest "$MANIFEST" -f Containerfile .
podman build --platform linux/ppc64le --manifest "$MANIFEST" -f Containerfile .

echo "Created local manifest: $MANIFEST"
echo "To publish: podman manifest push --all $MANIFEST docker://REGISTRY/NAME:TAG"
