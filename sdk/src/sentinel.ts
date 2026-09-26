/**
 * The sentinel's public output: a watchtower's advisory read of an SLA, published as an SPL
 * Memo on a check transaction. The Mandate program ignores it.
 *
 * Provenance. Snapshots are permissionless, so anyone can attach a memo that claims any
 * model. A read is therefore bound and attributed, never trusted by its text:
 *   - it names the mandate (`k`), the on-chain check it assessed (`o`, that check's
 *     timestamp), when it was assessed (`at`), when it stops being current (`exp`), the
 *     policy and the hash of the facts it was computed from (`p`, `h`);
 *   - its publisher is the memo instruction's signer, verified by the runtime (the
 *     transaction doesn't land without that signature), and read from the transaction's
 *     instructions, not from log text;
 *   - apps label a read as coming from a known watchtower only when that publisher is on
 *     their own list. A signature proves who published the read, not that a model ran.
 * Reads without these fields (format 1) are ignored.
 */

/** What a maker's situation can look like, with the words the app shows. */
export const DIAGNOSIS_LABELS = {
  quoting_normally: "Quoting normally",
  thin_but_compliant: "Thin but compliant",
  withdrew_liquidity: "Maker withdrew liquidity",
  reference_moved: "Reference moved past the quotes",
  out_of_range: "Price left the maker's range",
  not_started: "No liquidity placed yet",
  unclear: "Not enough evidence yet",
} as const;
export type Diagnosis = keyof typeof DIAGNOSIS_LABELS;

export interface SentinelAssessment {
  /** P(the next check finds the obligations unmet): drives where checks go. From rules. */
  risk: number;
  /** P(the agreement breaches: its failed-period limit is reached before the term ends). */
  breach: number;
  diagnosis: Diagnosis;
  confidence: number;
  /** P(no liquidity is placed back, or kept placed, within the next two scoring periods). NaN = abstained. */
  noRedeploy: number;
  /** Who judged: a model id, "rules", or "<model>+rules". */
  source: string;
}

/** A read as published: the assessment plus what binds it to one observation. */
export interface PublishedRead extends SentinelAssessment {
  mandate: string;
  /** Timestamp of the on-chain check (Mandate.last.ts) this read assessed. */
  observedTs: number;
  assessedAt: number;
  expiresAt: number;
  /** Assessment policy version (questions, rules and wording). */
  policy: string;
  /** First 12 hex chars of sha256 over the facts the read was computed from. */
  inputHash: string;
}

export interface VerifiedRead {
  read: PublishedRead;
  /** The memo's signer (verified by the runtime), else the fee payer. */
  publisher: string;
  sig: string;
}

export const MEMO_PREFIX = "mandate-sentinel/2";
export const SENTINEL_POLICY = "s2";

const num = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");

/** e.g. `mandate-sentinel/2 k=<mandate> o=1758000400 at=1758000410 exp=1758000470 d=withdrew_liquidity c=0.85 r=0.90 b=0.71 x=0.77 m=jev-1.13.0+rules p=s2 h=3fa9c2d1e0b4` */
export function encodeSentinelMemo(r: PublishedRead) {
  return [
    MEMO_PREFIX,
    `k=${r.mandate}`,
    `o=${Math.floor(r.observedTs)}`,
    `at=${Math.floor(r.assessedAt)}`,
    `exp=${Math.floor(r.expiresAt)}`,
    `d=${r.diagnosis}`,
    `c=${num(r.confidence)}`,
    `r=${num(r.risk)}`,
    `b=${num(r.breach)}`,
    `x=${num(r.noRedeploy)}`,
    `m=${r.source.replace(/[^\w.+:-]/g, "_").slice(0, 40)}`,
    `p=${r.policy.replace(/[^\w.-]/g, "_").slice(0, 12)}`,
    `h=${r.inputHash.replace(/[^0-9a-f]/g, "").slice(0, 12)}`,
  ].join(" ");
}

export function decodeSentinelMemo(text: string): PublishedRead | null {
  if (!text.startsWith(MEMO_PREFIX + " ")) return null;
  const kv: Record<string, string> = {};
  for (const part of text.slice(MEMO_PREFIX.length).trim().split(/\s+/)) {
    const i = part.indexOf("=");
    if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
  }
  const prob = (k: string) => {
    if (kv[k] === undefined || kv[k] === "-") return NaN;
    const v = Number(kv[k]);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : NaN;
  };
  const int = (k: string) => (/^\d{1,12}$/.test(kv[k] ?? "") ? Number(kv[k]) : NaN);
  const read: PublishedRead = {
    mandate: kv.k ?? "",
    observedTs: int("o"),
    assessedAt: int("at"),
    expiresAt: int("exp"),
    diagnosis: kv.d as Diagnosis,
    confidence: prob("c"),
    risk: prob("r"),
    breach: prob("b"),
    noRedeploy: prob("x"),
    source: kv.m ?? "unknown",
    policy: kv.p ?? "",
    inputHash: kv.h ?? "",
  };
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(read.mandate)) return null;
  if (!(read.diagnosis in DIAGNOSIS_LABELS)) return null;
  if (![read.observedTs, read.assessedAt, read.expiresAt].every(Number.isFinite)) return null;
  if (read.assessedAt < read.observedTs || read.expiresAt <= read.assessedAt) return null;
  if (Number.isNaN(read.risk) || Number.isNaN(read.confidence)) return null;
  return read;
}

/** The minimal shape of a fetched transaction this needs (web3.js getTransaction, legacy or v0). */
interface TxLike {
  transaction: {
    signatures: string[];
    message: {
      compiledInstructions: { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }[];
      getAccountKeys(args?: any): { get(i: number): { toBase58(): string } | undefined };
      isAccountSigner(i: number): boolean;
    };
  };
  meta?: { err?: unknown; loadedAddresses?: any } | null;
}

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/**
 * Every well-formed read in a successful transaction's top-level memo instructions, with
 * its publisher: the memo's signer account, else the fee payer. Both are signatures the
 * runtime verified before the transaction landed.
 */
export function sentinelReadsFromTx(tx: TxLike): VerifiedRead[] {
  if (!tx?.transaction?.message || tx.meta?.err) return [];
  const msg = tx.transaction.message;
  let keys: ReturnType<TxLike["transaction"]["message"]["getAccountKeys"]>;
  try {
    keys = msg.getAccountKeys(tx.meta?.loadedAddresses ? { accountKeysFromLookups: tx.meta.loadedAddresses } : undefined);
  } catch {
    return [];
  }
  const out: VerifiedRead[] = [];
  for (const ix of msg.compiledInstructions ?? []) {
    if (keys.get(ix.programIdIndex)?.toBase58() !== MEMO_PROGRAM) continue;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(ix.data);
    } catch {
      continue;
    }
    const read = decodeSentinelMemo(text);
    if (!read) continue;
    const signerIdx = ix.accountKeyIndexes.find((i) => msg.isAccountSigner(i));
    const publisher = keys.get(signerIdx ?? 0)?.toBase58();
    if (!publisher) continue;
    out.push({ read, publisher, sig: tx.transaction.signatures[0] });
  }
  return out;
}

/** Hex sha256 prefix of a JSON-able value (Web Crypto: works in Node 20+ and browsers). */
export async function inputHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type ReadStanding =
  /** Published by a watchtower this app lists, about this mandate, still current. */
  | "trusted"
  /** About this mandate and current, but from a publisher this app doesn't list. */
  | "unverified"
  /** Past its expiry: no longer current. */
  | "expired"
  /** Names a different mandate than the check it rode on: ignore it. */
  | "mismatch";

/**
 * How an app should present a read that arrived with a check on `mandate`. Only `trusted`
 * reads may be shown with their claimed model; the rest are third-party commentary at most.
 */
export function readStanding(v: VerifiedRead, o: { mandate: string; trusted: ReadonlySet<string> | ReadonlyMap<string, unknown>; now: number }): ReadStanding {
  if (v.read.mandate !== o.mandate) return "mismatch";
  // A read always describes the check before the one it rides on; only its own expiry ends it.
  if (o.now >= v.read.expiresAt) return "expired";
  return o.trusted.has(v.publisher) ? "trusted" : "unverified";
}
