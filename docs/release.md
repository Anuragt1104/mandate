# Releasing the program

What has to be true before the program holds real value, and how each release is recorded.
None of this is done for mainnet yet.

## Upgrade authority

- Devnet: the deployer's key, so fixes ship quickly. Anyone using devnet should assume the
  program can change.
- Mainnet: a multisig (for example Squads) with at least 2 of 3 independent signers, a public
  list of signers, and a stated delay between announcing an upgrade and executing it. After an
  independent review and a period without incidents, consider making the program immutable.
  Every upgrade changes the rules for existing agreements, so upgrades that change scoring,
  payment or slashing semantics should only apply to agreements created afterwards (a version
  field on the mandate), or wait until existing agreements end.

## Before a release

1. CI green: Rust tests, LiteSVM tests against the current Meteora mainnet binaries, off-chain
   tests, type-checks, app build, and no SBF stack or syscall diagnostics.
2. An independent smart-contract review of the diff since the last reviewed release.
3. A deployment manifest committed with the release (below).

## The manifest

`scripts/manifest.sh` records what is being deployed and, once deployed, what is on chain:

```bash
bash scripts/manifest.sh devnet
```

It writes `release/<cluster>-<commit>.json` with the commit, the toolchain, SHA-256 of
`target/deploy/mandate.so` and of the IDL, and (after deployment) the SHA-256 of the program
as dumped from the cluster, so anyone can check the deployed bytes match the reviewed build.
Builds are only comparable when they use the same toolchain; `solana-verify` gives a fully
reproducible build and is the better check for mainnet.
