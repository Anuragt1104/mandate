"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { usePoll, useNow } from "@/lib/hooks";
import { loadBoard } from "@/lib/loaders";
import { usePersonas } from "@/lib/personas";
import { CLUSTER } from "@/lib/chain";
import { SlaBoard } from "./board";
import { ago } from "./ui";

const SPEC: [string, string][] = [
  ["Depth", "≥ 500 USDC each side within ±2%"],
  ["Spread", "≤ 100 bps at size"],
  ["Checked", "at random, by anyone"],
  ["Paid", "per compliant period, from escrow"],
  ["Remedy", "bond slashed after 3 misses"],
];

/** The landing hero: the thesis, then the live network it describes. */
export function NetworkHero() {
  const now = useNow(5000);
  const book = usePersonas();
  const { data: board } = usePoll(loadBoard, [], 15_000);
  const live = board?.rows.filter((r) => r.status === "Active") ?? [];
  const lastCheck = Math.max(0, ...live.map((r) => r.m.last.ts.toNumber()));

  return (
    <section className="hero">
      <div className="container">
        <div className="hero-top">
          <div className="hero-copy">
            <span className="status-line">
              <span className="live-dot" />
              Live on Solana {CLUSTER}
              {board && <><span className="sep">/</span>{live.length} live SLA{live.length === 1 ? "" : "s"}</>}
              {lastCheck > 0 && <><span className="sep">/</span>last check {ago(Math.max(0, now - lastCheck))}</>}
            </span>
            <h1 className="display">Uptime for token markets.</h1>
            <p className="lead">
              Mandate puts a token&apos;s market maker under a liquidity SLA on Solana. Anyone can check the quotes at any moment, every
              period is scored on-chain, and a maker who stops quoting loses its bond.
            </p>
            <div className="hero-cta">
              <Link className="btn btn-primary btn-lg" href="/app">Open the network <ArrowRight /></Link>
              <Link className="btn btn-secondary btn-lg" href="/app/create">Draft an SLA</Link>
            </div>
          </div>
          <div className="hero-side">
            <span className="eyebrow">An SLA in five lines</span>
            <dl className="dl" style={{ gridTemplateColumns: "84px minmax(0, 1fr)", fontSize: 14 }}>
              {SPEC.map(([k, v]) => (
                <div key={k} style={{ display: "contents" }}>
                  <dt className="mono" style={{ fontSize: 12, paddingTop: 2 }}>{k}</dt>
                  <dd style={{ textAlign: "left", fontWeight: 560 }}>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <SlaBoard board={board} book={book} now={now} limit={6} cells={52} />
      </div>
    </section>
  );
}
