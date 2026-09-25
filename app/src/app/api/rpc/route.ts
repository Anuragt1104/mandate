/**
 * Same-origin JSON-RPC proxy for the app. Browsers call /api/rpc; this forwards to the
 * cluster's RPC with the same per-method hedged failover the bots use, from Vercel's network.
 * Public RPC throttles by client IP, so one busy network (a demo machine running bots, an
 * office, a conference Wi-Fi) no longer slows every visitor behind it. Only the methods the
 * app uses are forwarded, and program scans are limited to the Mandate program.
 */
import { failoverFetch, PUBLIC_FALLBACKS } from "../../../../../sdk/src/rpc";

export const runtime = "edge";

const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "localnet";
const PRIMARY = process.env.RPC_UPSTREAM ?? process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8899";
const FALLBACKS = process.env.RPC_UPSTREAM_FALLBACKS?.split(",").filter(Boolean) ?? PUBLIC_FALLBACKS[CLUSTER] ?? [];
const upstream = failoverFetch([PRIMARY, ...FALLBACKS], { timeoutMs: 8_000, hedgeMs: 1_200, rounds: 2 });

const MANDATE_PROGRAM = "3YetFVe4F6MuYaHH7pAmTCZjtMnunQT1ufMdAY8rYFrn";
const ALLOWED = new Set([
  "getAccountInfo", "getMultipleAccounts", "getProgramAccounts", "getBalance", "getTokenAccountBalance", "getTokenAccountsByOwner",
  "getSignaturesForAddress", "getTransaction", "getSignatureStatuses", "getLatestBlockhash", "isBlockhashValid", "getFeeForMessage",
  "getMinimumBalanceForRentExemption", "getRecentPrioritizationFees", "getSlot", "getBlockHeight", "getBlockTime", "getEpochInfo",
  "getGenesisHash", "getVersion", "getHealth", "sendTransaction", "simulateTransaction", "requestAirdrop",
]);

function refuse(id: unknown, message: string) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message } });
}

export async function POST(req: Request) {
  const body = await req.text();
  if (body.length > 64_000) return refuse(null, "request too large");
  let calls: any;
  try {
    calls = JSON.parse(body);
  } catch {
    return refuse(null, "invalid JSON");
  }
  const list = Array.isArray(calls) ? calls : [calls];
  if (!list.length || list.length > 20) return refuse(null, "batch size not allowed");
  for (const c of list) {
    if (!ALLOWED.has(c?.method)) return refuse(c?.id, `method ${String(c?.method)} is not served by this proxy`);
    if (c.method === "getProgramAccounts" && c.params?.[0] !== MANDATE_PROGRAM) return refuse(c.id, "program scans are limited to the Mandate program");
  }
  try {
    const res = await upstream("", { method: "POST", headers: { "content-type": "application/json" }, body });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (e: any) {
    return Response.json({ jsonrpc: "2.0", id: list[0]?.id ?? null, error: { code: -32000, message: `upstream RPC unavailable: ${e?.message ?? e}` } }, { status: 502 });
  }
}
