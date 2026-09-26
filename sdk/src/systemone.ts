/**
 * A minimal client for System One decision models: send a state and typed questions, get
 * typed answers with calibrated probabilities, never generated text. It speaks the TypeSafe
 * wire format, which Venice serves Jev on (POST /api/v1/decisions) and which open models
 * such as Kev and CLM serve at /v1/systemone, so the same code runs against any of them.
 */

export type NoulQuestion = { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };
export type ChoiceQuestion = { type: "choice"; instructions: unknown; criteria: Record<string, unknown | null> };
export type ScoreQuestion = { type: "score"; instructions: unknown; criteria: unknown[] };
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type NoulAnswer = { type: "noul"; noul: number };
export type ChoiceAnswer = { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number };
export type ScoreAnswer = { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

/** Answers typed by the questions that were asked. */
export type AnswersFor<Q extends Record<string, Question>> = {
  [K in keyof Q]: Q[K] extends NoulQuestion ? NoulAnswer : Q[K] extends ChoiceQuestion ? ChoiceAnswer : ScoreAnswer;
};

export interface DecisionResult<Q extends Record<string, Question>> {
  /** The model id the provider says answered (not just the one requested). */
  model: string;
  answers: AnswersFor<Q>;
  usage?: { input_tokens: number; output_tokens: number };
  latencyMs: number;
}

export interface SystemOneConfig {
  /** Full endpoint URL, e.g. https://api.venice.ai/api/v1/decisions. */
  url: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * The model version evaluated in docs/sentinel-eval.json. Pinned so a provider-side release
 * can't change behaviour silently; set SYSTEMONE_MODEL to evaluate and promote another.
 */
export const PINNED_MODEL = "jev-1.13.0";

/**
 * Pick an endpoint from the environment: an explicit SYSTEMONE_URL (a local Kev or CLM
 * server, say), then Jev from TypeSafe, then Jev on Venice.
 */
export function systemOneFromEnv(env: Record<string, string | undefined>): SystemOneConfig | null {
  const model = env.SYSTEMONE_MODEL ?? PINNED_MODEL;
  if (env.SYSTEMONE_URL) return { url: env.SYSTEMONE_URL, apiKey: env.SYSTEMONE_API_KEY, model };
  if (env.TYPESAFE_API_KEY) return { url: "https://api.typesafe.ai/v1/systemone", apiKey: env.TYPESAFE_API_KEY, model };
  if (env.VENICE_API_KEY) return { url: "https://api.venice.ai/api/v1/decisions", apiKey: env.VENICE_API_KEY, model };
  return null;
}

export class SystemOneError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

const isProb = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;

/** A probability distribution over exactly `keys` (sums to 1 within rounding). */
function checkDistribution(p: unknown, keys: string[] | null, where: string) {
  if (!p || typeof p !== "object") throw new SystemOneError(`${where}: probabilities missing`);
  const entries = Object.entries(p as Record<string, unknown>);
  for (const [k, v] of entries) {
    if (keys && !keys.includes(k)) throw new SystemOneError(`${where}: unexpected option ${k}`);
    if (!isProb(v)) throw new SystemOneError(`${where}: probability for ${k} is not in [0, 1]`);
  }
  const sum = entries.reduce((a, [, v]) => a + (v as number), 0);
  if (entries.length === 0 || Math.abs(sum - 1) > 0.02) throw new SystemOneError(`${where}: probabilities sum to ${sum.toFixed(3)}`);
}

/** Check every answer against the question it answers; throws on anything malformed. */
export function validateAnswers(questions: Record<string, Question>, answers: unknown): void {
  if (!answers || typeof answers !== "object") throw new SystemOneError("decision API returned no answers");
  const a = answers as Record<string, any>;
  for (const [id, q] of Object.entries(questions)) {
    const ans = a[id];
    const where = `answer ${id}`;
    if (!ans || typeof ans !== "object") throw new SystemOneError(`decision API returned no answer for ${id}`);
    if (ans.type !== undefined && ans.type !== q.type) throw new SystemOneError(`${where}: expected ${q.type}, got ${ans.type}`);
    if (q.type === "noul") {
      if (!isProb(ans.noul)) throw new SystemOneError(`${where}: noul is not a probability`);
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      if (typeof ans.choice !== "string" || !keys.includes(ans.choice)) throw new SystemOneError(`${where}: choice ${String(ans.choice)} is not an option`);
      checkDistribution(ans.probabilities, keys, where);
      if (!isProb(ans.confidence)) throw new SystemOneError(`${where}: confidence is not a probability`);
    } else {
      if (typeof ans.score !== "number" || !Number.isFinite(ans.score)) throw new SystemOneError(`${where}: score is not a number`);
      checkDistribution(ans.probabilities, null, where);
      if (!isProb(ans.confidence)) throw new SystemOneError(`${where}: confidence is not a probability`);
    }
  }
}

export async function decide<Q extends Record<string, Question>>(cfg: SystemOneConfig, state: unknown, questions: Q): Promise<DecisionResult<Q>> {
  const started = Date.now();
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model ?? PINNED_MODEL, state, questions }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new SystemOneError(`decision API answered ${res.status}: ${text.slice(0, 200)}`, res.status);
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SystemOneError("decision API returned invalid JSON");
  }
  validateAnswers(questions, body?.answers);
  if (body.model !== undefined && (typeof body.model !== "string" || !/^[\w.+:-]{1,64}$/.test(body.model))) throw new SystemOneError("decision API returned an invalid model id");
  return { model: body.model ?? cfg.model ?? "unknown", answers: body.answers, usage: body.usage, latencyMs: Date.now() - started };
}
