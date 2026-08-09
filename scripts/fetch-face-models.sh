#!/usr/bin/env bash
# Download the two InsightFace buffalo_s ONNX models used by src/lib/face-model.ts and verify
# their SHA-256. Never commit the models (see .gitignore) — 16 MB of binary that would live in
# this public repo's history forever. Used by: pnpm dev / pnpm test:int locally, the CI `test`
# job, and (via the same digests) the Dockerfile's model stage.
#   scripts/fetch-face-models.sh [target-dir]      default: ./models/faces
# Licence note: the InsightFace model zoo states "ALL models are available for non-commercial
# research purposes only." A Verein photo archive satisfies that; see docs/betrieb.md.
set -euo pipefail
target="${1:-models/faces}"
base="https://huggingface.co/deepghs/insightface/resolve/4e1f33d3fe0e50a0945f3a53ab94ae8977ae7ddb/buffalo_s"
# name:sha256 — pinned to the revision above, verified 2026-08-09
files=(
  "det_500m.onnx:5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a"
  "w600k_mbf.onnx:9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f"
)
mkdir -p "$target"
for entry in "${files[@]}"; do
  name="${entry%%:*}"
  want="${entry##*:}"
  path="$target/$name"
  if [ -f "$path" ] && [ "$(sha256sum "$path" | cut -d' ' -f1)" = "$want" ]; then
    echo "ok (cached): $name"
    continue
  fi
  echo "downloading: $name"
  curl -fsSL --retry 3 -o "$path.tmp" "$base/$name"
  got="$(sha256sum "$path.tmp" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    rm -f "$path.tmp"
    echo "SHA-256 mismatch for $name: expected $want, got $got" >&2
    exit 1
  fi
  mv "$path.tmp" "$path"
  echo "ok: $name"
done
