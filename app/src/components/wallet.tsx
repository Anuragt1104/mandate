"use client";

import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ChevronDown, Copy, Droplets, ExternalLink, LogOut, Wallet } from "lucide-react";
import { CLUSTER, explorerAddress } from "@/lib/chain";
import { Identicon, shortAddr } from "./ui";

export function WalletButton({ size = "md" }: { size?: "sm" | "md" }) {
  const { publicKey, connected, connecting, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const { connection } = useConnection();
  const [open, setOpen] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [faucet, setFaucet] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !publicKey) return;
    connection.getBalance(publicKey).then((l) => setBalance(l / LAMPORTS_PER_SOL)).catch(() => setBalance(null));
  }, [open, publicKey, connection, faucet]);

  const cls = size === "sm" ? "btn btn-sm" : "btn";
  if (!connected || !publicKey) {
    return (
      <button className={`${cls} btn-ink`} onClick={() => setVisible(true)} disabled={connecting}>
        <Wallet />
        {connecting ? "Connecting…" : "Connect signing wallet"}
      </button>
    );
  }

  const address = publicKey.toBase58();
  async function airdrop() {
    setFaucet("busy");
    try {
      const sig = await connection.requestAirdrop(publicKey!, LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      setFaucet("done");
    } catch {
      setFaucet("failed");
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className={`${cls} btn-secondary`} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" style={{ paddingLeft: 8 }}>
        <Identicon address={address} size={20} />
        <span className="mono" style={{ fontSize: 13 }}>{shortAddr(address)}</span>
        <ChevronDown style={{ width: 14, height: 14, color: "var(--faint)" }} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <div className="row" style={{ gap: 10 }}>
              <Identicon address={address} size={32} />
              <div style={{ display: "grid" }}>
                <span className="mono" style={{ fontSize: 13, color: "var(--ink)" }}>{shortAddr(address, 6)}</span>
                <span className="xs muted">{wallet?.adapter.name ?? "Wallet"} · {balance === null ? "…" : `${balance.toLocaleString("en-US", { maximumFractionDigits: 4 })} SOL`}</span>
              </div>
            </div>
          </div>
          <div className="note" style={{ marginTop: 0 }}>Your signing wallet approves terms and signs transactions. It isn&apos;t an account: drafts and observations you create stay in this browser.</div>
          <button role="menuitem" onClick={copy}><Copy />{copied ? "Copied" : "Copy address"}</button>
          <a role="menuitem" href={explorerAddress(address)} target="_blank" rel="noreferrer"><ExternalLink />View on Solana Explorer</a>
          {CLUSTER !== "mainnet" && (
            <>
              <button role="menuitem" onClick={airdrop} disabled={faucet === "busy"}>
                <Droplets />
                {faucet === "busy" ? "Requesting 1 SOL…" : faucet === "done" ? "Received 1 test SOL" : `Get test SOL (${CLUSTER})`}
              </button>
              {faucet === "failed" && (
                <div className="note">
                  The public faucet is rate-limited right now. Copy your address and request SOL at{" "}
                  <a href="https://faucet.solana.com" target="_blank" rel="noreferrer" style={{ display: "inline", padding: 0, color: "var(--ink)", textDecoration: "underline" }}>faucet.solana.com</a>.
                </div>
              )}
            </>
          )}
          <hr className="divider" style={{ margin: "6px 0" }} />
          <button role="menuitem" onClick={() => { setOpen(false); disconnect(); }}><LogOut />Disconnect</button>
        </div>
      )}
    </div>
  );
}
