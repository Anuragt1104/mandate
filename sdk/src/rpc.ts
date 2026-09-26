/**
 * A `fetch` for web3.js `Connection` that spreads JSON-RPC calls over several endpoints of
 * the same cluster. Public RPC degrades unevenly: an endpoint can keep answering some methods
 * while it hangs on others, so health is tracked per method.
 *
 * Each call is a hedged race: it goes to the endpoint that last served its method well (the
 * primary by default); if that has not answered within `hedgeMs`, or fails, the next endpoint
 * is tried too, and the first good answer wins while the rest are cancelled. Timeouts, HTTP
 * 429/5xx and JSON-RPC rate-limit errors count as failures. An endpoint that lost a race or
 * timed out is tried after the others for that method for 90 seconds, so traffic returns to
 * the primary once it recovers. Healthy calls never touch the fallbacks.
 */
/**
 * Endpoints are named by a safe label everywhere a message can escape (errors, logs, HTTP
 * responses): keyed providers put credentials in the query string or userinfo, so only the
 * host is shown.
 */
export function endpointLabel(url: string, index?: number): string {
  try {
    const u = new URL(url);
    return `${index === undefined ? "" : `rpc#${index + 1} `}${u.host}`;
  } catch {
    return index === undefined ? "rpc" : `rpc#${index + 1}`;
  }
}

/**
 * Reduce every URL in `text` to its scheme and host (providers put keys in the query, the
 * path or userinfo), and mask key-like parameters that appear on their own.
 */
export function redact(text: string): string {
  return String(text)
    .replace(/(https?|wss?):\/\/([^\s/@"']+@)?([^\s/?#"']+)([^\s?#"']*)(\?[^\s#"']*)?(#[^\s"']*)?/gi, (_m, proto, _auth, host) => `${proto}://${host}`)
    .replace(/((?:api[-_]?key|token|secret|auth|key)=)[^&\s"']+/gi, "$1[redacted]");
}

const RATE_LIMITED = /"error"\s*:\s*\{\s*"code"\s*:\s*(-32029|429|-32005)\b|too many requests|rate limit/i;
const REPROBE_MS = 90_000;

export function failoverFetch(endpoints: string[], opts: { timeoutMs?: number; hedgeMs?: number; rounds?: number } = {}) {
  const urls = [...new Set(endpoints.filter(Boolean))];
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const hedgeMs = opts.hedgeMs ?? 1_500;
  const rounds = opts.rounds ?? 3;
  const slowAt = new Map<string, number>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function accept(res: Response, url: string): Promise<Response> {
    const label = endpointLabel(url, urls.indexOf(url));
    if (res.status === 429 || res.status >= 500) throw new Error(`${label} answered HTTP ${res.status}`);
    const text = await res.clone().text();
    if (RATE_LIMITED.test(text.slice(0, 300))) throw new Error(`${label} is rate limiting`);
    // Some providers answer 200 with a body that isn't JSON-RPC (a gateway or quota message):
    // treat it as a failure so another endpoint answers, instead of handing it to the client.
    if (!/"jsonrpc"\s*:\s*"2\.0"/.test(text) || !/"(result|error)"\s*:/.test(text)) throw new Error(`${label} answered something that isn't JSON-RPC`);
    return res;
  }

  function race(order: number[], init: any, method: string): Promise<Response> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let next = 0;
      let running = 0;
      let lastErr: unknown = new Error("no RPC endpoint answered");
      const aborts = new Map<number, () => void>();
      const launch = () => {
        if (settled || next >= order.length) return;
        const idx = order[next++];
        running++;
        const ctrl = new AbortController();
        aborts.set(idx, () => ctrl.abort());
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const hedge = setTimeout(launch, hedgeMs);
        fetch(urls[idx], { ...init, signal: ctrl.signal })
          .then((res) => accept(res, urls[idx]))
          .then((res) => {
            clearTimeout(timer);
            clearTimeout(hedge);
            if (settled) return;
            settled = true;
            // Endpoints still running lost the race: try them after the winner for a while.
            for (const [other, abort] of aborts) {
              if (other === idx) continue;
              slowAt.set(`${method}|${other}`, Date.now());
              abort();
            }
            slowAt.delete(`${method}|${idx}`);
            resolve(res);
          })
          .catch((e) => {
            clearTimeout(timer);
            clearTimeout(hedge);
            aborts.delete(idx);
            running--;
            if (settled) return;
            // Transport errors can quote the request URL; never let it through.
            const label = endpointLabel(urls[idx], idx);
            const why = redact(e?.name === "AbortError" ? "timed out" : e?.message ?? String(e));
            lastErr = new Error(why.startsWith(label) ? why : `${label}: ${why}`);
            slowAt.set(`${method}|${idx}`, Date.now());
            if (next < order.length) launch();
            else if (running === 0) {
              settled = true;
              reject(lastErr);
            }
          });
      };
      launch();
    });
  }

  return async (_input: any, init?: any): Promise<Response> => {
    let method = "";
    try {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null");
      method = (Array.isArray(body) ? body[0]?.method : body?.method) ?? "";
    } catch {
      /* not a JSON-RPC body */
    }
    let lastErr: unknown;
    for (let round = 0; round < rounds; round++) {
      const slow = (i: number) => Date.now() - (slowAt.get(`${method}|${i}`) ?? 0) < REPROBE_MS;
      const order = urls.map((_, i) => i).sort((a, b) => Number(slow(a)) - Number(slow(b)) || a - b);
      try {
        return await race(order, init, method);
      } catch (e) {
        lastErr = e;
        await sleep(Math.min(8_000, 500 * 2 ** round));
      }
    }
    throw lastErr;
  };
}

/** Keyless fallbacks known to serve the same cluster (checked by genesis hash). */
export const PUBLIC_FALLBACKS: Record<string, string[]> = {
  devnet: ["https://solana-devnet.api.onfinality.io/public"],
};
