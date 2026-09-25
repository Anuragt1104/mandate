import { AccountInfo, Commitment, Connection, PublicKey, Transaction } from "@solana/web3.js";
import { LiteSVM } from "litesvm";

/**
 * A `Connection` backed by LiteSVM so SDKs that read chain state (e.g. Meteora's DBC SDK)
 * can build transactions in tests exactly as they would against a real cluster.
 */
export class SvmConnection extends Connection {
  constructor(private svm: LiteSVM) {
    super("http://127.0.0.1:1");
  }

  private toInfo(pk: PublicKey): AccountInfo<Buffer> | null {
    const a = this.svm.getAccount(pk);
    if (!a) return null;
    return {
      data: Buffer.from(a.data),
      executable: a.executable,
      lamports: Number(a.lamports),
      owner: a.owner,
      rentEpoch: 0,
    };
  }

  override async getAccountInfo(pk: PublicKey, _c?: any): Promise<AccountInfo<Buffer> | null> {
    return this.toInfo(pk);
  }

  override async getAccountInfoAndContext(pk: PublicKey, _c?: any): Promise<any> {
    return { context: { slot: Number(this.svm.getClock().slot) }, value: this.toInfo(pk) };
  }

  override async getMultipleAccountsInfo(pks: PublicKey[], _c?: any): Promise<(AccountInfo<Buffer> | null)[]> {
    return pks.map((pk) => this.toInfo(pk));
  }

  override async getMultipleAccountsInfoAndContext(pks: PublicKey[], _c?: any): Promise<any> {
    return { context: { slot: Number(this.svm.getClock().slot) }, value: pks.map((pk) => this.toInfo(pk)) };
  }

  override async getLatestBlockhash(_c?: Commitment | any): Promise<any> {
    return { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000_000 };
  }

  override async getMinimumBalanceForRentExemption(len: number, _c?: Commitment): Promise<number> {
    return Number(this.svm.minimumBalanceForRentExemption(BigInt(len)));
  }

  override async getSlot(_c?: any): Promise<number> {
    return Number(this.svm.getClock().slot);
  }

  override async getBlockTime(_slot: number): Promise<number | null> {
    return Number(this.svm.getClock().unixTimestamp);
  }

  override async getEpochInfo(_c?: any): Promise<any> {
    const c = this.svm.getClock();
    return { epoch: Number(c.epoch), slotIndex: 0, slotsInEpoch: 432000, absoluteSlot: Number(c.slot), blockHeight: Number(c.slot) };
  }

  override async simulateTransaction(_tx: Transaction | any, ..._rest: any[]): Promise<any> {
    throw new Error("simulateTransaction is not supported by SvmConnection");
  }
}
