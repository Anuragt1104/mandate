/**
 * A shared draft: how a team and its operator reach identical terms before any money moves.
 *
 * A draft is a document that travels as a link (no server keeps it): the market, the two
 * parties' wallets, every proposed version of the terms with who proposed it, and approvals.
 * An approval is a wallet signature over the canonical hash of one version's terms and the
 * parties, so "both approved" means both signed the same bytes. Funding and acceptance use
 * exactly the approved version; anything edited after an approval needs a fresh one.
 *
 * Nothing here is on chain: a draft is a negotiation record. Active agreements stay
 * immutable; changing terms means a new draft (a renewal), approved again.
 */

export interface DraftTerms {
  feePerPeriod: string;
  periodMinutes: string;
  durationPeriods: string;
  bond: string;
  maxSpreadBps: string;
  minDepth: string;
  depthWindowBps: string;
  bandBps: string;
  twapMinutes: string;
  speedPctPerMin: string;
  liquidityLockSecs: string;
  maxConsecutiveFailures: string;
  slashPct: string;
  baseDeposit: string;
  quoteDeposit: string;
}

export interface DraftMarket {
  cluster: string;
  baseMint: string;
  quoteMint: string;
  lbPair: string;
  referencePool: string;
  base?: string;
  quote?: string;
}

export type Party = "team" | "operator";

export interface DraftVersion {
  n: number;
  by: Party;
  at: number;
  note?: string;
  terms: DraftTerms;
}

export interface Approval {
  n: number;
  party: Party;
  signer: string;
  hash: string;
  /** base58 ed25519 signature over approvalMessage(hash, party). */
  sig: string;
}

export interface DraftDoc {
  kind: "mandate-draft";
  v: 1;
  id: string;
  title?: string;
  market: DraftMarket;
  /** The team's wallet (the issuer that funds the agreement). */
  team?: string;
  /** The operator's wallet (the designated maker). */
  operator?: string;
  versions: DraftVersion[];
  approvals: Approval[];
  /** A shared observation report the terms were based on. */
  evidence?: string;
  /** The agreement this draft renews, if any. */
  renews?: string;
  /** Set once the approved version was funded and posted. */
  posted?: { mandate: string; sig: string };
}

export const TERM_FIELDS: { key: keyof DraftTerms; label: string; group: "fee" | "bond" | "duration" | "service" | "reference" | "failure" | "funding"; unit?: string }[] = [
  { key: "feePerPeriod", label: "Fee per compliant period", group: "fee", unit: "quote" },
  { key: "bond", label: "Operator bond", group: "bond", unit: "quote" },
  { key: "slashPct", label: "Slash on breach", group: "bond", unit: "%" },
  { key: "periodMinutes", label: "Period length", group: "duration", unit: "min" },
  { key: "durationPeriods", label: "Number of periods", group: "duration" },
  { key: "minDepth", label: "Depth each side", group: "service", unit: "quote" },
  { key: "depthWindowBps", label: "Depth measured within", group: "service", unit: "bps" },
  { key: "maxSpreadBps", label: "Max spread", group: "service", unit: "bps" },
  { key: "bandBps", label: "Allowed band", group: "service", unit: "bps" },
  { key: "twapMinutes", label: "Reference time-weighted over", group: "reference", unit: "min" },
  { key: "speedPctPerMin", label: "Reference max speed", group: "reference", unit: "%/min" },
  { key: "maxConsecutiveFailures", label: "Failed periods before breach", group: "failure" },
  { key: "liquidityLockSecs", label: "Liquidity lock", group: "failure", unit: "s" },
  { key: "baseDeposit", label: "Token inventory", group: "funding", unit: "base" },
  { key: "quoteDeposit", label: "Quote inventory", group: "funding", unit: "quote" },
];

export const GROUP_LABELS: Record<(typeof TERM_FIELDS)[number]["group"], string> = {
  fee: "Fee",
  bond: "Bond and penalty",
  duration: "Duration",
  service: "Service levels",
  reference: "Reference behaviour",
  failure: "Failure conditions",
  funding: "Inventory",
};

export interface TermChange {
  key: keyof DraftTerms;
  label: string;
  group: string;
  from: string;
  to: string;
}

/** What changed between two versions of the terms, grouped as the parties think about them. */
export function diffTerms(a: DraftTerms, b: DraftTerms): TermChange[] {
  return TERM_FIELDS.filter((f) => Number(a[f.key]) !== Number(b[f.key])).map((f) => ({ key: f.key, label: f.label, group: GROUP_LABELS[f.group], from: a[f.key], to: b[f.key] }));
}

const canonicalNumber = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : v;
};

/** The bytes both parties sign: this draft, one version's terms, the market and both wallets, canonically ordered. */
export function canonicalTerms(doc: DraftDoc, n: number): string {
  const version = doc.versions.find((v) => v.n === n);
  if (!version) throw new Error(`no version ${n}`);
  const terms = Object.fromEntries(TERM_FIELDS.map((f) => [f.key, canonicalNumber(version.terms[f.key])]));
  const m = doc.market;
  return JSON.stringify({
    kind: "mandate-terms/1",
    // Bound to this draft (and the agreement it renews), so an approval can't be replayed
    // onto another draft that happens to have identical terms, such as a renewal.
    draft: doc.id,
    renews: doc.renews ?? null,
    version: n,
    market: { cluster: m.cluster, baseMint: m.baseMint, quoteMint: m.quoteMint, lbPair: m.lbPair, referencePool: m.referencePool },
    team: doc.team ?? null,
    operator: doc.operator ?? null,
    terms,
  });
}

export async function termsHash(doc: DraftDoc, n: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalTerms(doc, n)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function approvalMessage(hash: string, party: Party): Uint8Array {
  return new TextEncoder().encode(
    `Mandate: I approve these liquidity agreement terms as the ${party === "team" ? "token team" : "operator"}.\nTerms hash: ${hash}\nSigning moves no funds.`,
  );
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("invalid base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}
export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = n * 256n + BigInt(x);
  let s = "";
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

/** Verify an approval's ed25519 signature with Web Crypto (Node 20+, current browsers). */
export async function verifyApproval(a: Approval): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(base58Decode(a.signer)), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(base58Decode(a.sig)), new Uint8Array(approvalMessage(a.hash, a.party)));
  } catch {
    return false;
  }
}

export interface ApprovalState {
  latest: DraftVersion;
  hash: string;
  team: Approval | null;
  operator: Approval | null;
  /** Both parties signed the latest version's hash, as the wallets named in the draft. */
  agreed: boolean;
  /** Approvals on older versions or other wallets: kept for the record, not counted. */
  stale: Approval[];
}

/** Which valid approvals cover the latest version. Invalid signatures are dropped. */
export async function approvalState(doc: DraftDoc): Promise<ApprovalState> {
  const latest = doc.versions[doc.versions.length - 1];
  const hash = await termsHash(doc, latest.n);
  const valid = (await Promise.all(doc.approvals.map(async (a) => ((await verifyApproval(a)) ? a : null)))).filter(Boolean) as Approval[];
  const counts = (a: Approval) => a.hash === hash && a.n === latest.n && a.signer === (a.party === "team" ? doc.team : doc.operator);
  const team = valid.find((a) => a.party === "team" && counts(a)) ?? null;
  const operator = valid.find((a) => a.party === "operator" && counts(a)) ?? null;
  return { latest, hash, team, operator, agreed: !!team && !!operator, stale: valid.filter((a) => !counts(a)) };
}

// ---------------------------------------------------------------- economics

export interface Economics {
  /** Quote the team escrows for fees: every period's fee, up front. */
  feeBudget: number;
  /** Everything the team puts in, by token. */
  teamQuote: number;
  teamBase: number;
  /** What the operator locks. */
  bond: number;
  termHours: number;
  maxPayment: number;
  /** Maximum payment over the bond, and annualised. */
  returnOnBond: number | null;
  annualised: number | null;
  /** The bond at risk from one breach. */
  slashAmount: number;
  /** Periods the operator must keep the book continuously. */
  periods: number;
}

export function economics(t: DraftTerms): Economics {
  const n = (k: keyof DraftTerms) => Number(t[k]) || 0;
  const periods = n("durationPeriods");
  const feeBudget = n("feePerPeriod") * periods;
  const termHours = (n("periodMinutes") * periods) / 60;
  const bond = n("bond");
  const returnOnBond = bond > 0 ? feeBudget / bond : null;
  return {
    feeBudget,
    teamQuote: n("quoteDeposit") + feeBudget,
    teamBase: n("baseDeposit"),
    bond,
    termHours,
    maxPayment: feeBudget,
    returnOnBond,
    annualised: returnOnBond !== null && termHours > 0 ? returnOnBond * (8760 / termHours) : null,
    slashAmount: (bond * n("slashPct")) / 100,
    periods,
  };
}

export function newDraft(market: DraftMarket, terms: DraftTerms, by: Party = "team", extra: Partial<DraftDoc> = {}): DraftDoc {
  const now = Math.floor(Date.now() / 1000);
  return { kind: "mandate-draft", v: 1, id: `${market.lbPair.slice(0, 6)}-${now.toString(36)}`, market, versions: [{ n: 1, by, at: now, terms }], approvals: [], ...extra };
}

/** Append a proposed version (approvals on earlier versions stay in the record but no longer count). */
export function propose(doc: DraftDoc, terms: DraftTerms, by: Party, note?: string): DraftDoc {
  const n = (doc.versions[doc.versions.length - 1]?.n ?? 0) + 1;
  return { ...doc, versions: [...doc.versions, { n, by, at: Math.floor(Date.now() / 1000), note, terms }] };
}

// ---------------------------------------------------------------- to chain

/** A decimal string as integer atoms, refusing more decimal places than the token has (no silent rounding). */
export function toAtoms(v: string, decimals: number): bigint {
  const s = v.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`${v} is not a plain decimal number`);
  const [i, f = ""] = s.split(".");
  if (f.length > decimals) throw new Error(`${v} has more decimal places than the token allows (${decimals})`);
  return BigInt(i + f.padEnd(decimals, "0"));
}

/**
 * The approved terms as the program's arguments, exactly: every amount converted without
 * rounding, and the fee budget set to cover every period, as acceptance requires.
 */
export function draftToChain(t: DraftTerms, baseDecimals: number, quoteDecimals: number) {
  const q = (v: string) => toAtoms(v, quoteDecimals);
  const int = (v: string, what: string) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a whole number`);
    return n;
  };
  const feePerPeriod = q(t.feePerPeriod);
  const durationPeriods = int(t.durationPeriods, "Number of periods");
  const periodSecs = Math.round(Number(t.periodMinutes) * 60);
  return {
    terms: {
      feePerPeriod,
      periodSecs,
      durationPeriods,
      bondAmount: q(t.bond),
      maxSpreadBps: int(t.maxSpreadBps, "Max spread"),
      minDepthQuote: q(t.minDepth),
      depthWindowBps: int(t.depthWindowBps, "Depth window"),
      bandBps: int(t.bandBps, "Band"),
      anchorTwapSecs: Math.round(Number(t.twapMinutes) * 60),
      anchorSpeedBpsPerMin: Math.round(Number(t.speedPctPerMin) * 100),
      liquidityLockSecs: int(t.liquidityLockSecs, "Liquidity lock"),
      maxConsecutiveFailures: int(t.maxConsecutiveFailures, "Failed periods before breach"),
      slashBps: Math.round(Number(t.slashPct) * 100),
    },
    baseDeposit: toAtoms(t.baseDeposit, baseDecimals),
    quoteDeposit: q(t.quoteDeposit),
    feeBudget: feePerPeriod * BigInt(durationPeriods),
  };
}
