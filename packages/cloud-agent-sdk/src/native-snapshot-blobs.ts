/**
 * Retained attachment bytes for the native snapshot reader. Blobs are content addressed and
 * immutable, so one settled read can answer every later snapshot of the same session, across
 * reconnects, resets and recovery cycles, without another download or base64 encode.
 */

/** One resolved attachment body, already in the form the snapshot publishes. */
export type NativeSnapshotBlob = { bytes: number; base64: string };

type Entry = NativeSnapshotBlob & { sessionID: string; hash: string };

/** One key per retained body; the separator cannot appear in a session ID. */
function entryKey(sessionID: string, hash: string): string {
  return `${sessionID}\u0000${hash}`;
}

/**
 * Attachment bodies retained across snapshot reads, keyed by session and content hash. The
 * budget counts advertised blob bytes over every session of one client; the oldest entries
 * go first (insertion order), and a session's entries leave together when it closes.
 */
export class NativeSnapshotBlobCache {
  private readonly entries = new Map<string, Entry>();
  private retained = 0;

  constructor(private readonly budgetBytes: number) {}

  /** The retained body for `hash`, or `undefined` when it is absent or a different size. */
  read(sessionID: string, hash: string, bytes: number): NativeSnapshotBlob | undefined {
    const key = entryKey(sessionID, hash);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.bytes !== bytes) {
      // The advertised size disagrees with the settled body, so this entry cannot answer the
      // read. Drop it rather than serve bytes the caller did not authorize.
      this.drop(key, entry);
      return undefined;
    }
    // Re-reads move the entry to the newest position the eviction reads.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { bytes: entry.bytes, base64: entry.base64 };
  }

  /** Retain one resolved body, evicting the oldest entries until it fits the budget. */
  write(sessionID: string, hash: string, blob: NativeSnapshotBlob): void {
    // A body larger than the whole budget is never retained: it would evict every other entry
    // and the cache would still exceed its bound.
    if (blob.bytes > this.budgetBytes) return;
    const key = entryKey(sessionID, hash);
    const previous = this.entries.get(key);
    if (previous) this.drop(key, previous);
    this.entries.set(key, { ...blob, sessionID, hash });
    this.retained += blob.bytes;
    while (this.retained > this.budgetBytes) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) {
        this.retained = 0;
        return;
      }
      this.drop(oldest[0], oldest[1]);
    }
  }

  /** Drop every body retained for one session, which closes that snapshot history. */
  forgetSession(sessionID: string): void {
    for (const [key, entry] of this.entries)
      if (entry.sessionID === sessionID) this.drop(key, entry);
  }

  private drop(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.retained -= entry.bytes;
  }
}
