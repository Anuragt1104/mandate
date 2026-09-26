"use client";

import { use, useEffect } from "react";
import Link from "next/link";
import { useAccount } from "@/components/account";

/**
 * /app/w/<workspace>/…: a link that opens a specific workspace, so a colleague following it
 * sees the same observations, drafts and reports. Opening it switches this browser to that
 * workspace; someone who isn't a member is told so instead of seeing another workspace's work.
 */
export default function WorkspaceRoute({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const acct = useAccount();
  const member = acct.workspaces.some((w) => w.id === id);
  useEffect(() => {
    if (member && acct.current?.id !== id) acct.open(id);
  }, [member, id, acct.current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const gate = (title: string, text: string, href: string, action: string) => (
    <>
      <div className="page-head"><div><span className="eyebrow">Workspace</span><h1 className="h1">{title}</h1></div></div>
      <div className="card" style={{ maxWidth: 560 }}>
        <div className="card-body" style={{ display: "grid", gap: 12 }}>
          <span className="small">{text}</span>
          <Link className="btn btn-primary" style={{ justifySelf: "start" }} href={href}>{action}</Link>
        </div>
      </div>
    </>
  );
  if (!acct.enabled) return gate("Accounts aren't set up here", "This deployment keeps work in each browser.", "/app", "Go to the overview");
  if (acct.loading) return null;
  if (!acct.user) return gate("Sign in to open this workspace", "This link opens a shared workspace. Sign in with the account that was invited.", "/app/account", "Sign in");
  if (!acct.ready) return null;
  if (!member) return gate("You're not in this workspace", "Ask one of its admins for an invitation link.", "/app", "Go to your overview");
  if (acct.current?.id !== id) return null;
  return <>{children}</>;
}
