"use client";

import { useMemo, useState } from "react";
import { Connection } from "@solana/web3.js";
import { AnchorProvider, Idl, Program } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction, Signer } from "@solana/web3.js";
import idl from "../../../sdk/idl/mandate.json";
import { MandateClient } from "../../../sdk/src";
import { useToast } from "@/components/Providers";
import { RPC_URL, explorerUrl, freshFetch } from "./chain";

/** Reads for signing never come from a dashboard cache (see freshFetch). */
let _fresh: Connection | null = null;
const freshConnection = () => (_fresh ??= new Connection(RPC_URL, { commitment: "confirmed", fetch: freshFetch as any, disableRetryOnRateLimit: true }));

const ERRORS: Record<number, string> = Object.fromEntries(((idl as any).errors ?? []).map((e: any) => [e.code, e.msg]));

/** Turn a failed transaction into a sentence the user can act on. */
export function describeError(e: any): string {
  const text = [e?.message, ...(e?.logs ?? []), ...(e?.transactionLogs ?? [])].filter(Boolean).join("\n");
  const hex = text.match(/custom program error: (0x[0-9a-f]+)/i);
  if (hex) {
    const code = parseInt(hex[1], 16);
    if (ERRORS[code]) return ERRORS[code];
  }
  const anchor = text.match(/Error Message: ([^.\n]+)/);
  if (anchor) return anchor[1];
  if (/User rejected/i.test(text)) return "You rejected the request in your wallet.";
  if (/insufficient (funds|lamports)/i.test(text)) return "Your wallet does not have enough SOL to pay for this transaction.";
  return e?.message?.split("\n")[0] ?? "Transaction failed.";
}

export function useMandateActions() {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  const { sendTransaction, publicKey } = useWallet();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const client = useMemo(
    () => (anchorWallet ? new MandateClient(new Program(idl as Idl, new AnchorProvider(connection, anchorWallet, {}))) : null),
    [anchorWallet, connection],
  );

  /**
   * Build, simulate (the wallet's preflight), send and confirm one transaction. With
   * `mandate`, the agreement is re-read first, bypassing any cache, and the fresh state is
   * passed to `build`, so the transaction matches the account as it is now. Confirmation is
   * bounded by the blockhash's validity; if that passes without a confirmation, the
   * signature's history is checked, and an unknown outcome is reported as unknown (with the
   * link), never as a failure the user might retry into a duplicate.
   */
  async function run(
    label: string,
    build: (c: MandateClient, me: PublicKey, fresh: any | null) => Promise<TransactionInstruction[]>,
    opts: { signers?: Signer[]; done?: string; mandate?: PublicKey } = {},
  ): Promise<boolean> {
    if (!client || !publicKey) {
      toast({ kind: "error", text: "Connect a wallet first." });
      return false;
    }
    setBusy(label);
    const conn = freshConnection();
    let sig: string | null = null;
    try {
      let fresh: any = null;
      if (opts.mandate) {
        const info = await conn.getAccountInfo(opts.mandate, "confirmed");
        if (!info) throw new Error("The agreement could not be read right now. Try again in a moment.");
        fresh = client.decodeMandate(info.data);
      }
      const ixs = await build(client, publicKey, fresh);
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
      sig = await sendTransaction(tx, connection, { signers: opts.signers, preflightCommitment: "confirmed" });
      const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed").catch(() => null);
      if (res?.value.err) throw new Error(JSON.stringify(res.value.err));
      if (!res) {
        const st = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
        if (st?.err) throw new Error(JSON.stringify(st.err));
        if (!st?.confirmationStatus) {
          toast({ kind: "error", text: `${label}: the network didn't confirm in time, and it may still land. Check the transaction before trying again.`, href: explorerUrl(sig) });
          return false;
        }
      }
      toast({ kind: "info", text: opts.done ?? `${label}: done.`, href: explorerUrl(sig) });
      return true;
    } catch (e: any) {
      toast({ kind: "error", text: `${label} failed. ${describeError(e)}`, href: sig ? explorerUrl(sig) : undefined });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { client, me: publicKey, run, busy };
}
