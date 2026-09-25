#!/usr/bin/env bash
# Local validator with Mandate + Meteora mainnet programs (DLMM, DAMM v2, DBC, Token Metadata)
# and the mainnet accounts they depend on (DLMM presets, DAMM v2 migration configs).
set -euo pipefail
cd "$(dirname "$0")/.."
ARGS=(
  --bpf-program 3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn target/deploy/mandate.so
  --bpf-program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo fixtures/programs/dlmm.so
  --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG fixtures/programs/damm_v2.so
  --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN fixtures/programs/dbc.so
  --bpf-program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s fixtures/programs/mpl_token_metadata.so
)
for f in fixtures/accounts/*.json fixtures/localnet/*.json; do
  pk=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['pubkey'])" "$f")
  ARGS+=(--account "$pk" "$f")
done
mkdir -p .anchor
exec solana-test-validator --reset --quiet --ledger .anchor/localnet-ledger "${ARGS[@]}" "$@"
