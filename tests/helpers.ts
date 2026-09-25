import fs from "fs";
import path from "path";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  AccountLayout,
} from "@solana/spl-token";
import { Clock, FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";

const ROOT = path.resolve(__dirname, "..");

export const MANDATE_PROGRAM_ID = new PublicKey("3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn");
export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const MPL_TOKEN_METADATA_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** Mainnet DLMM PresetParameter2 accounts, keyed by bin step (see fixtures/accounts.txt). */
export const PRESET_BY_BIN_STEP: Record<number, PublicKey> = {
  10: new PublicKey("5b2QSa3oY5DUzi4su8DdVTMVTS2gDe6P8YswfJq5BPqG"),
  25: new PublicKey("FxGzUdJZWPCe7LiZvB9YLDtyHBZcC8EBpG2Hhw9T8Yts"),
  80: new PublicKey("3PG2K7jaj4X2nFM69NJs2Lv98ZzRkAXJBku4bZQMhfpE"),
  100: new PublicKey("BHheFrz5LwtomeCufgoERctJyXi7tzwBjfnZdaHWGKdh"),
};

export const ONE_Q64 = 1n << 64n;

// ---------------------------------------------------------------------------
// SVM
// ---------------------------------------------------------------------------

export function startSvm(): LiteSVM {
  const svm = new LiteSVM();
  // Start from a realistic wall-clock time (LiteSVM defaults to unix_timestamp = 0).
  const c = svm.getClock();
  svm.setClock(new Clock(c.slot, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, 1_758_000_000n));
  svm.addProgramFromFile(MANDATE_PROGRAM_ID, path.join(ROOT, "target/deploy/mandate.so"));
  svm.addProgramFromFile(DLMM_PROGRAM_ID, path.join(ROOT, "fixtures/programs/dlmm.so"));
  svm.addProgramFromFile(DAMM_V2_PROGRAM_ID, path.join(ROOT, "fixtures/programs/damm_v2.so"));
  svm.addProgramFromFile(DBC_PROGRAM_ID, path.join(ROOT, "fixtures/programs/dbc.so"));
  svm.addProgramFromFile(MPL_TOKEN_METADATA_ID, path.join(ROOT, "fixtures/programs/mpl_token_metadata.so"));
  const dir = path.join(ROOT, "fixtures/accounts");
  for (const f of fs.readdirSync(dir)) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    svm.setAccount(new PublicKey(j.pubkey), {
      lamports: j.account.lamports,
      data: Buffer.from(j.account.data[0], "base64"),
      owner: new PublicKey(j.account.owner),
      executable: false,
    });
  }
  return svm;
}

export function fundedKeypair(svm: LiteSVM, sol = 100): Keypair {
  const kp = Keypair.generate();
  svm.airdrop(kp.publicKey, BigInt(sol) * 1_000_000_000n);
  return kp;
}

export class TxError extends Error {
  constructor(public logs: string[], msg: string) {
    super(msg);
  }
}

export function send(
  svm: LiteSVM,
  payer: Keypair,
  ixs: TransactionInstruction[],
  signers: Keypair[] = [],
  cu = 1_400_000,
): TransactionMetadata {
  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }));
  tx.add(...ixs);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = payer.publicKey;
  const uniq = new Map<string, Keypair>();
  [payer, ...signers].forEach((k) => uniq.set(k.publicKey.toBase58(), k));
  tx.sign(...uniq.values());
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) {
    const logs = res.meta().logs();
    throw new TxError(logs, `tx failed: ${res.err().toString()}\n${logs.slice(-25).join("\n")}`);
  }
  return res;
}

/** Expect a transaction to fail and return its logs (for asserting error names). */
export function sendExpectFail(svm: LiteSVM, payer: Keypair, ixs: TransactionInstruction[], signers: Keypair[] = []): string[] {
  try {
    send(svm, payer, ixs, signers);
  } catch (e) {
    if (e instanceof TxError) return e.logs;
    throw e;
  }
  throw new Error("expected transaction to fail");
}

export function now(svm: LiteSVM): bigint {
  return svm.getClock().unixTimestamp;
}

export function warp(svm: LiteSVM, seconds: number) {
  const c = svm.getClock();
  svm.setClock(
    new Clock(c.slot + BigInt(Math.ceil(seconds * 2.5)), c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(seconds)),
  );
}

// ---------------------------------------------------------------------------
// Anchor programs (instruction building + decoding only; no RPC)
// ---------------------------------------------------------------------------

function offlineProvider(): AnchorProvider {
  return new AnchorProvider(new Connection("http://127.0.0.1:1"), new Wallet(Keypair.generate()), {});
}

export function mandateProgram(): Program<any> {
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/mandate.json"), "utf8")) as Idl;
  return new Program(idl, offlineProvider());
}

export function dlmmProgram(): Program<any> {
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "idl/dlmm.json"), "utf8")) as Idl;
  return new Program(idl, offlineProvider());
}

// ---------------------------------------------------------------------------
// SPL token helpers
// ---------------------------------------------------------------------------

export function createMint(svm: LiteSVM, payer: Keypair, decimals: number, authority = payer.publicKey): PublicKey {
  const mint = Keypair.generate();
  const rent = svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));
  send(
    svm,
    payer,
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mint.publicKey,
        lamports: Number(rent),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mint.publicKey, decimals, authority, null),
    ],
    [mint],
  );
  return mint.publicKey;
}

export function ata(mint: PublicKey, owner: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true);
}

export function ensureAta(svm: LiteSVM, payer: Keypair, mint: PublicKey, owner: PublicKey): PublicKey {
  const a = ata(mint, owner);
  if (!svm.getAccount(a)) {
    send(svm, payer, [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, a, owner, mint)]);
  }
  return a;
}

export function mintTo(svm: LiteSVM, authority: Keypair, mint: PublicKey, owner: PublicKey, amount: bigint): PublicKey {
  const a = ensureAta(svm, authority, mint, owner);
  send(svm, authority, [createMintToInstruction(mint, a, authority.publicKey, amount)]);
  return a;
}

export function tokenBalance(svm: LiteSVM, account: PublicKey): bigint {
  const acc = svm.getAccount(account);
  if (!acc) return 0n;
  return AccountLayout.decode(Buffer.from(acc.data)).amount;
}

// ---------------------------------------------------------------------------
// DLMM helpers
// ---------------------------------------------------------------------------

export function binArrayIndex(binId: number): number {
  return Math.floor(binId / 70);
}

function i64le(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}
function i32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n);
  return b;
}

export function deriveBinArray(lbPair: PublicKey, index: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bin_array"), lbPair.toBuffer(), i64le(index)], DLMM_PROGRAM_ID)[0];
}
export function deriveDlmmPosition(lbPair: PublicKey, base: PublicKey, lower: number, width: number): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), lbPair.toBuffer(), base.toBuffer(), i32le(lower), i32le(width)],
    DLMM_PROGRAM_ID,
  )[0];
}
export const DLMM_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], DLMM_PROGRAM_ID)[0];

export interface Pair {
  lbPair: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  oracle: PublicKey;
  tokenX: PublicKey;
  tokenY: PublicKey;
  binStep: number;
}

export function createDlmmPair(svm: LiteSVM, payer: Keypair, tokenX: PublicKey, tokenY: PublicKey, binStep: number, activeId: number): Pair {
  const dlmm = dlmmProgram();
  const preset = PRESET_BY_BIN_STEP[binStep];
  const [minKey, maxKey] = Buffer.compare(tokenX.toBuffer(), tokenY.toBuffer()) === 1 ? [tokenY, tokenX] : [tokenX, tokenY];
  const lbPair = PublicKey.findProgramAddressSync([preset.toBuffer(), minKey.toBuffer(), maxKey.toBuffer()], DLMM_PROGRAM_ID)[0];
  const reserveX = PublicKey.findProgramAddressSync([lbPair.toBuffer(), tokenX.toBuffer()], DLMM_PROGRAM_ID)[0];
  const reserveY = PublicKey.findProgramAddressSync([lbPair.toBuffer(), tokenY.toBuffer()], DLMM_PROGRAM_ID)[0];
  const oracle = PublicKey.findProgramAddressSync([Buffer.from("oracle"), lbPair.toBuffer()], DLMM_PROGRAM_ID)[0];
  const ix = dlmm.coder.instruction.encode("initializeLbPair2", { params: { activeId, padding: Array(96).fill(0) } });
  const keys = [
    { pubkey: lbPair, isSigner: false, isWritable: true },
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false }, // bitmap extension: none
    { pubkey: tokenX, isSigner: false, isWritable: false },
    { pubkey: tokenY, isSigner: false, isWritable: false },
    { pubkey: reserveX, isSigner: false, isWritable: true },
    { pubkey: reserveY, isSigner: false, isWritable: true },
    { pubkey: oracle, isSigner: false, isWritable: true },
    { pubkey: preset, isSigner: false, isWritable: false },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false }, // token badge x: none
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false }, // token badge y: none
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  send(svm, payer, [new TransactionInstruction({ programId: DLMM_PROGRAM_ID, keys, data: ix })]);
  return { lbPair, reserveX, reserveY, oracle, tokenX, tokenY, binStep };
}

export function initBinArrays(svm: LiteSVM, payer: Keypair, lbPair: PublicKey, indexes: number[]) {
  const dlmm = dlmmProgram();
  const ixs: TransactionInstruction[] = [];
  for (const index of indexes) {
    const binArray = deriveBinArray(lbPair, index);
    if (svm.getAccount(binArray)) continue;
    ixs.push(
      new TransactionInstruction({
        programId: DLMM_PROGRAM_ID,
        keys: [
          { pubkey: lbPair, isSigner: false, isWritable: false },
          { pubkey: binArray, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: dlmm.coder.instruction.encode("initializeBinArray", { index: new BN(index) }),
      }),
    );
  }
  if (ixs.length) send(svm, payer, ixs);
}

export function readActiveId(svm: LiteSVM, lbPair: PublicKey): number {
  return Buffer.from(svm.getAccount(lbPair)!.data).readInt32LE(76);
}

/** Swap on DLMM. `xToY` = sell X for Y. */
export function dlmmSwap(svm: LiteSVM, user: Keypair, pair: Pair, amountIn: bigint, xToY: boolean, binArrayIndexes: number[]) {
  const dlmm = dlmmProgram();
  const userX = ensureAta(svm, user, pair.tokenX, user.publicKey);
  const userY = ensureAta(svm, user, pair.tokenY, user.publicKey);
  const data = dlmm.coder.instruction.encode("swap2", {
    amountIn: new BN(amountIn.toString()),
    minAmountOut: new BN(0),
    remainingAccountsInfo: { slices: [] },
  });
  const keys = [
    { pubkey: pair.lbPair, isSigner: false, isWritable: true },
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: pair.reserveX, isSigner: false, isWritable: true },
    { pubkey: pair.reserveY, isSigner: false, isWritable: true },
    { pubkey: xToY ? userX : userY, isSigner: false, isWritable: true },
    { pubkey: xToY ? userY : userX, isSigner: false, isWritable: true },
    { pubkey: pair.tokenX, isSigner: false, isWritable: false },
    { pubkey: pair.tokenY, isSigner: false, isWritable: false },
    { pubkey: pair.oracle, isSigner: false, isWritable: true },
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false }, // host fee: none
    { pubkey: user.publicKey, isSigner: true, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: DLMM_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
    ...binArrayIndexes.map((i) => ({ pubkey: deriveBinArray(pair.lbPair, i), isSigner: false, isWritable: true })),
  ];
  send(svm, user, [new TransactionInstruction({ programId: DLMM_PROGRAM_ID, keys, data })]);
}

// ---------------------------------------------------------------------------
// Reference pool
// ---------------------------------------------------------------------------

/** Integer sqrt for bigint. */
export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

/** DLMM bin price as Q64.64 (float approximation is fine for test setup). */
export function binPriceQ64(binId: number, binStep: number): bigint {
  const p = Math.pow(1 + binStep / 10_000, binId);
  return BigInt(Math.round(p * 2 ** 32)) << 32n;
}

/**
 * Write a DAMM v2 Pool account at `address` with only the fields Mandate reads
 * (token_a/token_b mints, liquidity, sqrt_price). The full DBC→DAMM v2 flow is covered
 * by the end-to-end launch test.
 */
export function writeReferencePool(svm: LiteSVM, address: PublicKey, tokenA: PublicKey, tokenB: PublicKey, priceQ64: bigint) {
  const data = Buffer.alloc(1112);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(data, 0);
  tokenA.toBuffer().copy(data, 168);
  tokenB.toBuffer().copy(data, 200);
  const writeU128 = (v: bigint, o: number) => {
    data.writeBigUInt64LE(v & ((1n << 64n) - 1n), o);
    data.writeBigUInt64LE(v >> 64n, o + 8);
  };
  writeU128(1_000_000_000_000n, 360);
  writeU128(isqrt(priceQ64 << 64n), 456);
  svm.setAccount(address, { lamports: 10_000_000_000, data, owner: DAMM_V2_PROGRAM_ID, executable: false });
}

/** Sign and send a pre-built web3.js Transaction (e.g. from an SDK). */
export function sendTx(svm: LiteSVM, tx: Transaction, signers: Keypair[]): TransactionMetadata {
  tx.recentBlockhash = svm.latestBlockhash();
  if (!tx.feePayer) tx.feePayer = signers[0].publicKey;
  const hasCu = tx.instructions.some((i) => i.programId.equals(ComputeBudgetProgram.programId));
  if (!hasCu) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  const uniq = new Map<string, Keypair>();
  signers.forEach((k) => uniq.set(k.publicKey.toBase58(), k));
  tx.signatures = [];
  tx.sign(...uniq.values());
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (res instanceof FailedTransactionMetadata) {
    const logs = res.meta().logs();
    throw new TxError(logs, `tx failed: ${res.err().toString()}\n${logs.slice(-30).join("\n")}`);
  }
  return res;
}
