"use client";

import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Skeleton, ago } from "./ui";

interface Poll {
  data: unknown;
  error: string | null;
  updatedAt: number | null;
  since: number;
  reload: () => void;
}

/**
 * One section's data state, told apart: still loading (and slow), failed with nothing to show,
 * showing older data because the latest refresh failed, empty, or current.
 */
export function SectionState({ poll, now, empty, emptyText, children, skeletonRows = 3 }: { poll: Poll; now: number; empty?: boolean; emptyText?: string; children: ReactNode; skeletonRows?: number }) {
  const retry = <button className="btn btn-ghost btn-sm" onClick={() => poll.reload()}><RefreshCw />Retry</button>;
  if (poll.data == null) {
    if (poll.error) {
      return (
        <div className="section-state">
          <span className="small">Couldn&apos;t load this: {poll.error}</span>
          {retry}
        </div>
      );
    }
    const slow = now * 1000 - poll.since > 12_000;
    return (
      <div className="section-state" aria-busy="true">
        {Array.from({ length: skeletonRows }).map((_, i) => <Skeleton key={i} h={18} />)}
        {slow && <span className="xs muted row" style={{ gap: 8 }}>Still loading: the network is slow right now. {retry}</span>}
      </div>
    );
  }
  return (
    <>
      {poll.error && (
        <div className="notice warn xs" style={{ margin: 12 }}>
          Showing data from {poll.updatedAt ? ago(Math.max(0, Math.round((now * 1000 - poll.updatedAt) / 1000))) : "earlier"}; the latest refresh failed. {retry}
        </div>
      )}
      {empty ? <div className="empty-state"><span className="small">{emptyText}</span></div> : children}
    </>
  );
}

/** "Updated 12s ago", for headers of live data. */
export function Freshness({ updatedAt, now }: { updatedAt: number | null; now: number }) {
  if (!updatedAt) return null;
  return <span className="xs muted">Updated {ago(Math.max(0, Math.round((now * 1000 - updatedAt) / 1000)))}</span>;
}
