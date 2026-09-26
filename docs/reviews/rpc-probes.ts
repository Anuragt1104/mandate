/** Review-only mock transport probes; never contacts a real RPC. */
import assert from "node:assert/strict";
async function main() {
  process.env.RPC_UPSTREAM = "https://rpc.invalid/?api-key=REVIEW_DUMMY";
  process.env.RPC_UPSTREAM_FALLBACKS = "";
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => { attempts++; return Response.json({ jsonrpc: "2.0", id: 1, result: null }); };
  try {
    const { POST } = await import("../../app/src/app/api/rpc/route");
    const req = (method: string, params: unknown[] = []) => new Request("http://review.invalid/api/rpc", {
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) });
    await POST(req("getTransaction", ["REVIEW_SIGNATURE"]));
    globalThis.fetch = async () => { attempts++; return Response.json({ jsonrpc: "2.0", id: 1, result: { slot: 99 } }); };
    const second = await POST(req("getTransaction", ["REVIEW_SIGNATURE"]));
    assert.equal((await second.json()).result, null);
    assert.equal(attempts, 1);
    globalThis.fetch = async () => new Response("", { status: 503 });
    const error = await POST(req("getSlot"));
    assert((await error.text()).includes("REVIEW_DUMMY"));
    console.log(JSON.stringify({ reviewedCommit: "e607bc4", probes: [
      { id: "negative-transaction-cache", upstreamCalls: attempts, secondResponseSource: second.headers.get("x-rpc-source"), result: null, configuredTtlSeconds: 3600 },
      { id: "proxy-key-reflection", httpStatus: error.status, dummyCredentialInResponse: true },
    ] }, null, 2));
  } finally { globalThis.fetch = realFetch; }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
