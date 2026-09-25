"use client";

import { Buffer } from "buffer";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { CircleAlert, CircleCheck, X } from "lucide-react";
import { CLUSTER, RPC_URL } from "@/lib/chain";
import "@solana/wallet-adapter-react-ui/styles.css";

if (typeof window !== "undefined") (window as any).Buffer = (window as any).Buffer ?? Buffer;

type Toast = { kind: "info" | "error"; text: string; href?: string } | null;
const ToastCtx = createContext<(t: Toast) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function Providers({ children }: { children: ReactNode }) {
  // Wallet Standard wallets (Phantom, Solflare, Backpack…) are detected automatically.
  // A burner wallet is offered on local/dev clusters for demos only.
  const wallets = useMemo(() => (CLUSTER === "mainnet" ? [] : [new UnsafeBurnerWalletAdapter()]), []);
  const [toast, setToast] = useState<Toast>(null);
  const show = useCallback((t: Toast) => {
    setToast(t);
    if (t) setTimeout(() => setToast((cur) => (cur === t ? null : cur)), t.kind === "error" ? 12000 : 9000);
  }, []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <ToastCtx.Provider value={show}>
            {children}
            {toast && (
              <div className={`toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
                {toast.kind === "error" ? <CircleAlert /> : <CircleCheck />}
                <div style={{ display: "grid", gap: 4 }}>
                  <span>{toast.text}</span>
                  {toast.href && <a href={toast.href} target="_blank" rel="noreferrer">View transaction on Explorer</a>}
                </div>
                <button className="close" onClick={() => setToast(null)} aria-label="Dismiss"><X /></button>
              </div>
            )}
          </ToastCtx.Provider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
