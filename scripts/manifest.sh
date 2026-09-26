#!/usr/bin/env bash
# Record what a release deploys (see docs/release.md): commit, toolchain, and SHA-256 of the
# built program and IDL, plus the on-chain program's hash when it can be dumped.
#   bash scripts/manifest.sh [devnet|mainnet-beta|localnet]
set -euo pipefail
cd "$(dirname "$0")/.."
CLUSTER="${1:-devnet}"
PROGRAM=3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn
case "$CLUSTER" in
  devnet) URL=https://api.devnet.solana.com ;;
  mainnet-beta) URL=https://api.mainnet-beta.solana.com ;;
  *) URL=http://127.0.0.1:8899 ;;
esac
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
COMMIT=$(git rev-parse HEAD)
DIRTY=$([ -z "$(git status --porcelain -- programs Cargo.lock)" ] && echo false || echo true)
ONCHAIN=null
TMP=$(mktemp)
if solana program dump -u "$URL" "$PROGRAM" "$TMP" >/dev/null 2>&1; then ONCHAIN="\"$(sha "$TMP")\""; fi
rm -f "$TMP"
mkdir -p release
OUT="release/${CLUSTER}-${COMMIT:0:12}.json"
cat > "$OUT" <<JSON
{
  "program": "$PROGRAM",
  "cluster": "$CLUSTER",
  "commit": "$COMMIT",
  "programSourceDirty": $DIRTY,
  "toolchain": { "solana": "$(solana --version | head -1)", "anchor": "$(anchor --version 2>/dev/null || echo unknown)", "rustc": "$(rustc --version)" },
  "sha256": { "built": "$(sha target/deploy/mandate.so)", "idl": "$(sha target/idl/mandate.json)", "onChain": $ONCHAIN },
  "recordedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
cat "$OUT"
