import { BUNDLE_DENIED_REASONS } from '@kilocode/sts-contracts';
import { z } from 'zod';
import { getDenialStub } from '../dos/stubs';
import type { Env, StsConfig } from '../env';

/**
 * A refused bundle read from a caller STS identified: a Worker with valid props, or a provider
 * token whose signature verified. Claims are the provider's stable ids (never the token).
 */
export type Denial = {
  channel: 'worker-binding' | 'http';
  reason: (typeof BUNDLE_DENIED_REASONS)[number];
  actor: string;
  claims: Record<string, string>;
};

export const DenialSchema: z.ZodType<Denial> = z.strictObject({
  channel: z.enum(['worker-binding', 'http']),
  reason: z.enum(BUNDLE_DENIED_REASONS),
  actor: z.string().min(1).max(256),
  claims: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(256))
    .refine(claims => Object.keys(claims).length <= 16, { message: 'at most 16 claims' }),
});

/** Identical denials in one minute merge into one row; this is the identity they merge on. */
export function denialKey(denial: Denial): string {
  const claims = Object.keys(denial.claims)
    .sort()
    .map(name => [name, denial.claims[name]]);
  return JSON.stringify([denial.channel, denial.reason, denial.actor, claims]);
}

/** Distinct denials one isolate sends per minute before it counts the rest as overflow. */
export const MAX_ISOLATE_DISTINCT_PER_MINUTE = 100;

/**
 * Denials sent in one record call: `count` occurrences of `denial` (or of its reason when
 * `overflow`) in the UTC minute `minute` (`YYYY-MM-DDTHH:MM`) they happened in.
 */
export type DenialCount = { denial: Denial; count: number; overflow: boolean; minute: string };

/** A failed send's counts wait at most this many entries for the next hop; older ones are dropped. */
const MAX_RETRY_ENTRIES = 2 * MAX_ISOLATE_DISTINCT_PER_MINUTE;

export const DenialCountsSchema: z.ZodType<DenialCount[]> = z
  .array(
    z.strictObject({
      denial: DenialSchema,
      count: z.number().int().positive().max(1_000_000),
      overflow: z.boolean(),
      minute: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    })
  )
  .min(1)
  .max(MAX_RETRY_ENTRIES + MAX_ISOLATE_DISTINCT_PER_MINUTE + 8);

export function utcMinute(time: number): string {
  return new Date(time).toISOString().slice(0, 16);
}

/**
 * One distinct denial of the current minute. `unsent` counts occurrences not yet handed to the
 * denial object; `sent` is false until a send of this entry succeeded or is in flight.
 */
type Pending = {
  minute: string;
  denial: Denial;
  overflow: boolean;
  unsent: number;
  sent: boolean;
};

/**
 * Merges identical denials in one isolate per minute before the denial object hop. The first
 * occurrence of a denial in a minute is sent at once; repeats are only counted, and the counts of
 * a minute that has ended ride along with the next hop this isolate makes, each with its own
 * minute. So one isolate sends at most one record call per distinct denial per minute, and a
 * replayed token costs no hop at all after its first use. A failed send gives its counts back:
 * they go out with the isolate's next hop, which the next occurrence of that denial starts. Past `MAX_ISOLATE_DISTINCT_PER_MINUTE` distinct denials a minute, further ones are counted
 * per reason as overflow. Counts still pending when the isolate ends are lost.
 */
export class DenialBuffer {
  private readonly pending = new Map<string, Pending>();
  private retry: DenialCount[] = [];

  constructor(
    private readonly send: (counts: DenialCount[]) => Promise<void>,
    private readonly now: () => number,
    private readonly onFailure: (error: unknown, counts: DenialCount[]) => void = () => {}
  ) {}

  /** Returns the hop to run after the response, or null when this denial only adds to a count. */
  add(denial: Denial): Promise<void> | null {
    const minute = utcMinute(this.now());
    const batch = this.retry;
    this.retry = [];
    for (const [key, entry] of this.pending) {
      if (entry.minute === minute) continue;
      if (entry.unsent > 0) batch.push(this.countOf(entry));
      this.pending.delete(key);
    }

    const overflow =
      !this.pending.has(denialKey(denial)) && this.pending.size >= MAX_ISOLATE_DISTINCT_PER_MINUTE;
    const key = overflow ? `overflow:${denial.reason}` : denialKey(denial);
    let entry = this.pending.get(key);
    if (entry === undefined) {
      const recorded: Denial = overflow
        ? { channel: denial.channel, reason: denial.reason, actor: 'overflow', claims: {} }
        : denial;
      entry = { minute, denial: recorded, overflow, unsent: 0, sent: false };
      this.pending.set(key, entry);
    }
    entry.unsent += 1;
    // The new entry, and any a failed send gave back, go out with this hop.
    for (const waiting of this.pending.values()) {
      if (waiting.sent) continue;
      batch.push(this.countOf(waiting));
      waiting.sent = true;
    }
    return batch.length > 0 ? this.dispatch(batch) : null;
  }

  /** Moves an entry's unsent occurrences into a count for the batch. */
  private countOf(entry: Pending): DenialCount {
    const count: DenialCount = {
      denial: entry.denial,
      count: entry.unsent,
      overflow: entry.overflow,
      minute: entry.minute,
    };
    entry.unsent = 0;
    return count;
  }

  private async dispatch(batch: DenialCount[]): Promise<void> {
    try {
      await this.send(batch);
    } catch (error) {
      this.onFailure(error, batch);
      for (const count of batch) this.restore(count);
    }
  }

  private restore(count: DenialCount): void {
    const key = count.overflow ? `overflow:${count.denial.reason}` : denialKey(count.denial);
    const entry = this.pending.get(key);
    if (entry !== undefined && entry.minute === count.minute) {
      entry.unsent += count.count;
      entry.sent = false;
      return;
    }
    if (this.retry.length < MAX_RETRY_ENTRIES) this.retry.push(count);
  }
}

const buffers = new Map<string, DenialBuffer>();

/**
 * Counts one refused read in this isolate's buffer and returns the denial-object hop to pass to
 * `waitUntil`, or null. A failed hop is logged and its counts are kept for the next hop: the read
 * is refused either way.
 */
export function recordDenial(env: Env, config: StsConfig, denial: Denial): Promise<void> | null {
  let buffer = buffers.get(config.environment);
  if (buffer === undefined) {
    buffer = new DenialBuffer(
      counts => getDenialStub(env, config).record(counts),
      () => Date.now(),
      (error, counts) => {
        console.error('sts: bundle denials could not be recorded; kept for the next hop', {
          denials: counts.length,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    );
    buffers.set(config.environment, buffer);
  }
  return buffer.add(denial);
}

/** Test seam: forgets every isolate buffer, so a test's first denial is sent again. */
export function clearDenialBuffers(): void {
  buffers.clear();
}
