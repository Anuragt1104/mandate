"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { LogOut, Mail, Wallet } from "lucide-react";
import { cloud, oauthProviders, why } from "@/lib/cloud";
import { useAccount } from "@/components/account";

/** Sign in, so drafts, observations and reports live in a workspace a team shares. */
export default function AccountPage() {
  const acct = useAccount();
  const { wallet, publicKey, signMessage } = useWallet();
  const { setVisible } = useWalletModal();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [google, setGoogle] = useState(false);
  useEffect(() => {
    oauthProviders().then((p) => setGoogle(!!p.google));
  }, []);

  const back = typeof window !== "undefined" ? `${window.location.origin}/app/workspace` : undefined;

  async function run(what: string, f: () => Promise<{ error: unknown } | void>) {
    setBusy(what);
    setError(null);
    try {
      const r = await f();
      if (r && r.error) setError(why(r.error));
    } catch (e) {
      setError(why(e));
    } finally {
      setBusy(null);
    }
  }

  if (!acct.enabled) {
    return (
      <>
        <div className="page-head"><div><span className="eyebrow">Account</span><h1 className="h1">Accounts aren&apos;t set up here</h1></div></div>
        <div className="card"><div className="card-body small muted">This deployment keeps drafts and observations in each browser. Accounts and shared workspaces need the Supabase settings.</div></div>
      </>
    );
  }

  if (acct.user) {
    return (
      <>
        <div className="page-head"><div><span className="eyebrow">Account</span><h1 className="h1">You&apos;re signed in</h1></div></div>
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="card-body" style={{ display: "grid", gap: 12 }}>
            <span className="small">{acct.user.email ?? acct.user.user_metadata?.custom_claims?.address ?? "Wallet account"}</span>
            <span className="xs muted">Your account holds your workspaces. Signing agreements and approvals still happens with a wallet, which can be different from how you sign in.</span>
            <div className="row" style={{ gap: 8 }}>
              <Link className="btn btn-primary" href="/app/workspace">Open workspace</Link>
              <button className="btn btn-secondary" onClick={acct.signOut}><LogOut />Sign out</button>
            </div>
            <span className="xs muted">Signing out removes workspace copies from this browser.</span>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Account</span>
          <h1 className="h1">Sign in to share work with your team</h1>
          <p className="muted" style={{ margin: 0, maxWidth: "62ch" }}>
            An account keeps drafts, observations and reports in a workspace your colleagues and your operator can open, instead of in this browser only. Agreements and funds stay on chain either way.
          </p>
        </div>
      </div>

      <div className="card" style={{ maxWidth: 560 }}>
        <div className="card-body" style={{ display: "grid", gap: 16 }}>
          {!sent ? (
            <form
              style={{ display: "grid", gap: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                run("email", async () => {
                  const r = await cloud()!.auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: back } });
                  if (!r.error) setSent(true);
                  return r;
                });
              }}
            >
              <label className="field">
                <span className="field-label">Work email</span>
                <input className="input" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourproject.xyz" />
              </label>
              <button className="btn btn-primary" disabled={!!busy || !email.includes("@")}><Mail />{busy === "email" ? "Sending…" : "Email me a sign-in link"}</button>
            </form>
          ) : (
            <form
              style={{ display: "grid", gap: 10 }}
              onSubmit={(e) => {
                e.preventDefault();
                run("code", () => cloud()!.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" }));
              }}
            >
              <span className="small">We sent a sign-in link to <b>{email}</b>. Open it in this browser, or enter the code from the email.</span>
              <label className="field">
                <span className="field-label">Code</span>
                <input className="input mono" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              </label>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-primary" disabled={!!busy || code.length < 6}>{busy === "code" ? "Checking…" : "Sign in"}</button>
                <button type="button" className="btn btn-secondary" onClick={() => { setSent(false); setCode(""); }}>Use a different email</button>
              </div>
            </form>
          )}

          <div className="row" style={{ gap: 10 }}><span className="xs muted">or</span></div>

          {google && <button
            className="btn btn-secondary"
            disabled={!!busy}
            onClick={() => run("google", () => cloud()!.auth.signInWithOAuth({ provider: "google", options: { redirectTo: back } }))}
          >
            {busy === "google" ? "Opening Google…" : "Continue with Google"}
          </button>}

          <button
            className="btn btn-secondary"
            disabled={!!busy}
            onClick={() => {
              if (!publicKey || !signMessage) {
                setVisible(true);
                return;
              }
              run("wallet", () =>
                cloud()!.auth.signInWithWeb3({
                  chain: "solana",
                  statement: "Sign in to Mandate. This signature proves you control this wallet; it moves no funds.",
                  wallet: { publicKey, signMessage },
                }),
              );
            }}
          >
            <Wallet />
            {busy === "wallet" ? "Waiting for the wallet…" : publicKey ? `Sign in with ${wallet?.adapter.name ?? "wallet"}` : "Sign in with a Solana wallet"}
          </button>
          {publicKey && !signMessage && <span className="xs muted">This wallet can&apos;t sign messages; use email or Google.</span>}

          {error && <div className="notice" role="alert">{error}</div>}
        </div>
      </div>
    </>
  );
}
