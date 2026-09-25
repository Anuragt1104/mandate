"use client";

import { useMemo, useState } from "react";
import { AnchorProvider, Idl, Program } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction, Signer } from "@solana/web3.js";
import idl from "../../../sdk/idl/mandate.json";
import { MandateClient } from "../../../sdk/src";
import { useToast } from "@/components/Providers";
import { explorerUrl } from "./chain";

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

  async function run(
    label: string,
    build: (c: MandateClient, me: PublicKey) => Promise<TransactionInstruction[]>,
    opts: { signers?: Signer[]; done?: string } = {},
  ): Promise<boolean> {
    if (!client || !publicKey) {
      toast({ kind: "error", text: "Connect a wallet first." });
      return false;
    }
    setBusy(label);
    try {
      const ixs = await build(client, publicKey);
      const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...ixs);
      const sig = await sendTransaction(tx, connection, { signers: opts.signers, preflightCommitment: "confirmed" });
      const res = await connection.confirmTransaction(sig, "confirmed");
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      toast({ kind: "info", text: opts.done ?? `${label}: done.`, href: explorerUrl(sig) });
      return true;
    } catch (e: any) {
      toast({ kind: "error", text: `${label} failed. ${describeError(e)}` });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { client, me: publicKey, run, busy };
}
