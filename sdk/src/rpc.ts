/**
 * A `fetch` for web3.js `Connection` that spreads JSON-RPC calls over several endpoints of
 * the same cluster. Public RPC degrades unevenly: an endpoint can keep answering some methods
 * while it hangs on others, so health is tracked per method. A call goes first to the endpoint
 * that last answered its method (the primary by default) and skips endpoints that recently
 * timed out on it; a timeout, HTTP 429/5xx or a JSON-RPC rate-limit error moves it on, with a
 * short backoff between rounds. Endpoints are re-probed after 90 seconds, so traffic returns
 * to the primary once it recovers.
 */
const RATE_LIMITED = /"error"\s*:\s*\{\s*"code"\s*:\s*(-32029|429|-32005)\b|too many requests|rate limit/i;
const REPROBE_MS = 90_000;

export function failoverFetch(endpoints: string[], opts: { timeoutMs?: number; rounds?: number } = {}) {
  const urls = [...new Set(endpoints.filter(Boolean))];
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const rounds = opts.rounds ?? 4;
  const preferred = new Map<string, { idx: number; since: number }>();
  const hungAt = new Map<string, number>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return async (_input: any, init?: any): Promise<Response> => {
    let method = "";
    try {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null");
      method = (Array.isArray(body) ? body[0]?.method : body?.method) ?? "";
    } catch {
      /* not a JSON-RPC body */
    }
    const hung = (idx: number) => Date.now() - (hungAt.get(`${method}|${idx}`) ?? 0) < REPROBE_MS;
    const pref = preferred.get(method);
    const start = pref && Date.now() - pref.since < REPROBE_MS ? pref.idx : 0;
    const order = urls.map((_, i) => i).sort((a, b) => Number(hung(a)) - Number(hung(b)) || Number(b === start) - Number(a === start) || a - b);

    let lastErr: unknown = new Error("no RPC endpoint answered");
    for (let round = 0; round < rounds; round++) {
      const allHung = order.every(hung);
      for (const idx of order) {
        if (round === 0 && !allHung && hung(idx)) continue;
        try {
          const res = await fetch(urls[idx], { ...init, signal: AbortSignal.timeout(timeoutMs) });
          if (res.status === 429 || res.status >= 500) throw new Error(`${urls[idx]} answered HTTP ${res.status}`);
          const head = (await res.clone().text()).slice(0, 300);
          if (RATE_LIMITED.test(head)) throw new Error(`${urls[idx]} is rate limiting`);
          hungAt.delete(`${method}|${idx}`);
          if (idx === 0) preferred.delete(method);
          else if (!pref || pref.idx !== idx || start === 0) preferred.set(method, { idx, since: Date.now() });
          return res;
        } catch (e) {
          lastErr = e;
          if ((e as any)?.name === "TimeoutError") hungAt.set(`${method}|${idx}`, Date.now());
        }
      }
      await sleep(Math.min(8_000, 400 * 2 ** round));
    }
    throw lastErr;
  };
}

/** Keyless fallbacks known to serve the same cluster (checked by genesis hash). */
export const PUBLIC_FALLBACKS: Record<string, string[]> = {
  devnet: ["https://solana-devnet.api.onfinality.io/public"],
};
