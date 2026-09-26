/**
 * The watchtower's durable state: per mandate, the event cursor, transactions that could not
 * be read yet, verified maker activity, recent checks and the latest model read. It survives
 * restarts, so a keeper resumes where it stopped instead of rebuilding (or silently losing)
 * history. Plain JSON, written atomically (temp file + rename) at most once per `flushMs`.
 */
import fs from "fs";
import path from "path";

export interface CheckRecord {
  ts: number;
  ok: boolean;
  bids: number;
  asks: number;
  spreadBps: number | null;
  referenceBin: number;
}

export interface ModelRead {
  /** The on-chain check (Mandate.last.ts) the read assessed. */
  observedTs: number;
  inputHash: string;
  assessedAt: number;
  expiresAt: number;
  a: { breach: number; diagnosis: string; confidence: number; noRedeploy: number; source: string; latencyMs: number };
}

export interface MandateRecord {
  /** Newest signature at or below which every transaction was read or queued in `unresolved`. */
  cursor?: string;
  /** Signatures listed for the mandate whose transaction wasn't available yet. */
  unresolved: { sig: string; tries: number; firstSeen: number }[];
  /** Time before which the event history is known to have a gap (0 = complete). */
  gapBefore: number;
  /** Processed transaction:event ids (bounded). */
  seen: string[];
  activity: { ts: number; action: string; id: string }[];
  checks: CheckRecord[];
  model?: ModelRead;
}

export const emptyRecord = (): MandateRecord => ({ unresolved: [], gapBefore: 0, seen: [], activity: [], checks: [] });

export class KeeperStore {
  private data: { version: 1; mandates: Record<string, MandateRecord> } = { version: 1, mandates: {} };
  private dirty = false;
  private lastFlush = 0;

  constructor(private file: string | null, private flushMs = 5_000) {
    if (file && fs.existsSync(file)) {
      try {
        const d = JSON.parse(fs.readFileSync(file, "utf8"));
        if (d?.version === 1 && d.mandates) this.data = d;
      } catch {
        /* a corrupt file starts fresh; history is re-read from chain */
      }
    }
  }

  get(key: string): MandateRecord {
    const r = (this.data.mandates[key] ??= emptyRecord());
    this.dirty = true;
    return r;
  }

  has(key: string) {
    return key in this.data.mandates;
  }

  /** Forget mandates that are no longer watched (settled or cancelled). */
  retain(keys: Set<string>) {
    for (const k of Object.keys(this.data.mandates)) if (!keys.has(k)) delete this.data.mandates[k], (this.dirty = true);
  }

  flush(force = false) {
    if (!this.file || !this.dirty || (!force && Date.now() - this.lastFlush < this.flushMs)) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
    this.lastFlush = Date.now();
  }
}
