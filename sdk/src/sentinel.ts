/**
 * The sentinel's public output: a watchtower's assessment of an SLA, published as an SPL
 * Memo on the check transaction so anyone can read it next to the program's own measurement.
 * It is advisory: the Mandate program ignores it.
 */

/** What a maker's situation can look like, with the words the app shows. */
export const DIAGNOSIS_LABELS = {
  quoting_normally: "Quoting normally",
  thin_but_compliant: "Thin but compliant",
  withdrew_liquidity: "Maker withdrew liquidity",
  side_depleted_by_trading: "One side drained by trading",
  out_of_range: "Price left the maker's range",
  not_started: "Setting up",
  unclear: "Not enough evidence yet",
} as const;
export type Diagnosis = keyof typeof DIAGNOSIS_LABELS;

export interface SentinelAssessment {
  /** P(the next check finds the obligations unmet): drives where checks go. */
  risk: number;
  /** P(the maker lets the agreement breach). */
  breach: number;
  diagnosis: Diagnosis;
  confidence: number;
  /** P(the maker is deliberately leaving). */
  exit: number;
  /** Who judged: a model id, "rules", or "model+rules". */
  source: string;
}

export const MEMO_PREFIX = "mandate-sentinel/1";

/** e.g. `mandate-sentinel/1 r=0.83 b=0.71 d=withdrew_liquidity c=0.91 x=0.77 m=jev-1.13.0` */
export function encodeSentinelMemo(a: SentinelAssessment) {
  const p = (x: number) => (isFinite(x) ? x.toFixed(2) : "-");
  return `${MEMO_PREFIX} r=${p(a.risk)} b=${p(a.breach)} d=${a.diagnosis} c=${p(a.confidence)} x=${p(a.exit)} m=${a.source.replace(/\s+/g, "_").slice(0, 32)}`;
}

export function decodeSentinelMemo(text: string): SentinelAssessment | null {
  if (!text.startsWith(MEMO_PREFIX)) return null;
  const kv: Record<string, string> = {};
  for (const part of text.slice(MEMO_PREFIX.length).trim().split(/\s+/)) {
    const i = part.indexOf("=");
    if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1);
  }
  const num = (k: string) => (kv[k] !== undefined && kv[k] !== "-" && isFinite(Number(kv[k])) ? Number(kv[k]) : NaN);
  if (!(kv.d in DIAGNOSIS_LABELS) || isNaN(num("r"))) return null;
  return { risk: num("r"), breach: num("b"), diagnosis: kv.d as Diagnosis, confidence: num("c"), exit: num("x"), source: kv.m ?? "unknown" };
}

/** The memo text inside a transaction's logs, if the sentinel left one. */
export function sentinelMemoFromLogs(logs: string[]): SentinelAssessment | null {
  for (const l of logs) {
    const m = l.match(/Memo \(len \d+\): "(mandate-sentinel\/1[^"]*)"/);
    if (m) return decodeSentinelMemo(m[1]);
  }
  return null;
}
