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
 * Pick an endpoint from the environment: an explicit SYSTEMONE_URL (a local Kev or CLM
 * server, say), then Jev from TypeSafe, then Jev on Venice.
 */
export function systemOneFromEnv(env: Record<string, string | undefined>): SystemOneConfig | null {
  const model = env.SYSTEMONE_MODEL ?? "jev-latest";
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

export async function decide<Q extends Record<string, Question>>(cfg: SystemOneConfig, state: unknown, questions: Q): Promise<DecisionResult<Q>> {
  const started = Date.now();
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model ?? "jev-latest", state, questions }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new SystemOneError(`decision API answered ${res.status}: ${text.slice(0, 200)}`, res.status);
  const body = JSON.parse(text);
  for (const id of Object.keys(questions)) {
    if (!body.answers?.[id]) throw new SystemOneError(`decision API returned no answer for ${id}`);
  }
  return { model: body.model ?? cfg.model ?? "unknown", answers: body.answers, usage: body.usage, latencyMs: Date.now() - started };
}
