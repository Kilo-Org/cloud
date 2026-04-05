import { DurableObject } from 'cloudflare:workers';

const CLEANUP_INTERVAL_MS = 3_600_000; // 1 hour
const TTL_MS = 86_400_000; // 24 hours
const LIST_BATCH_SIZE = 1000;

export class GmailPushIdempotency extends DurableObject {
  /** Returns true if messageId was already processed. If new, marks it and returns false. */
  async checkAndMark(messageId: string): Promise<boolean> {
    const key = `msg:${messageId}`;
    const existing = await this.ctx.storage.get<number>(key);
    if (existing !== undefined) return true;
    await this.ctx.storage.put(key, Date.now());
    void this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    return false;
  }

  /** Alarm handler: delete entries older than 24h, paginating in batches. */
  override async alarm(): Promise<void> {
    const cutoff = Date.now() - TTL_MS;
    let cursor: string | undefined;
    let remaining = false;

    for (;;) {
      const batch = await this.ctx.storage.list<number>({
        prefix: 'msg:',
        limit: LIST_BATCH_SIZE,
        ...(cursor ? { startAfter: cursor } : {}),
      });

      if (batch.size === 0) break;

      const toDelete: string[] = [];
      for (const [key, ts] of batch) {
        if (ts < cutoff) {
          toDelete.push(key);
        } else {
          remaining = true;
        }
        cursor = key;
      }

      if (toDelete.length > 0) await this.ctx.storage.delete(toDelete);
      if (batch.size < LIST_BATCH_SIZE) break;
    }

    if (remaining) {
      void this.ctx.storage.setAlarm(Date.now() + CLEANUP_INTERVAL_MS);
    }
  }
}
