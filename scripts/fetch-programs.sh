#!/usr/bin/env bash
# Download the mainnet Meteora programs (and Metaplex Token Metadata) that the tests and
# the local validator load. Binaries are not committed; this recreates fixtures/programs/.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC="${MAINNET_RPC:-https://api.mainnet-beta.solana.com}"
mkdir -p fixtures/programs
dump() { [ -s "fixtures/programs/$2.so" ] || solana program dump -u "$RPC" "$1" "fixtures/programs/$2.so"; }
dump LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo dlmm
dump cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG damm_v2
dump dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN dbc
dump metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s mpl_token_metadata
ls -la fixtures/programs
