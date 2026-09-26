"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { pendingInvite, useAccount } from "@/components/account";

/**
 * An invitation link: /app/join#t=<token>. The token rides in the fragment so it never reaches
 * a server log; it's held in this browser until the person is signed in, then accepted.
 */
export default function JoinPage() {
  const acct = useAccount();
  const router = useRouter();
  const [has, setHas] = useState<boolean | null>(null);

  useEffect(() => {
    const m = window.location.hash.match(/[#&]t=([0-9a-f]{48})/);
    if (m) {
      pendingInvite(m[1]);
      history.replaceState(null, "", window.location.pathname);
    }
    setHas(!!pendingInvite());
  }, []);

  useEffect(() => {
    if (has && acct.user) acct.refresh().then(() => router.replace("/app/workspace"));
  }, [has, acct.user?.id]);

  return (
    <>
      <div className="page-head"><div><span className="eyebrow">Invitation</span><h1 className="h1">Join a workspace</h1></div></div>
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="card-body" style={{ display: "grid", gap: 12 }}>
          {!acct.enabled ? (
            <span className="small muted">Accounts aren&apos;t set up on this deployment.</span>
          ) : has === false ? (
            <span className="small">This link has no invitation in it. Ask for a new one; each link works once.</span>
          ) : acct.user ? (
            <span className="small">Joining…</span>
          ) : (
            <>
              <span className="small">You&apos;ve been invited to a Mandate workspace. Sign in, with the email the invitation was sent to if it names one, and you&apos;ll join it.</span>
              <Link className="btn btn-primary" style={{ justifySelf: "start" }} href="/app/account">Sign in to join</Link>
            </>
          )}
        </div>
      </div>
    </>
  );
}
