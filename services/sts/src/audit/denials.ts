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

/** Denials sent in one record call: `count` occurrences of `denial`, or of its reason when `overflow`. */
export type DenialCount = { denial: Denial; count: number; overflow: boolean };

export const DenialCountsSchema: z.ZodType<DenialCount[]> = z
  .array(
    z.strictObject({
      denial: DenialSchema,
      count: z.number().int().positive().max(1_000_000),
      overflow: z.boolean(),
    })
  )
  .min(1)
  .max(2 * MAX_ISOLATE_DISTINCT_PER_MINUTE + 8);

function utcMinute(time: number): string {
  return new Date(time).toISOString().slice(0, 16);
}

type Pending = { minute: string; count: DenialCount };

/**
 * Merges identical denials in one isolate per minute before the denial object hop. The first
 * occurrence of a denial in a minute is sent at once; repeats are only counted, and the counts of
 * a minute that has ended ride along with the next hop this isolate makes. So one isolate sends at
 * most one record call per distinct denial per minute, and a replayed token costs no hop at all
 * after its first use. Past `MAX_ISOLATE_DISTINCT_PER_MINUTE` distinct denials a minute, further
 * ones are counted per reason as overflow. Counts still pending when the isolate ends are lost; the
 * first occurrence of every distinct denial is always sent.
 */
export class DenialBuffer {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly send: (counts: DenialCount[]) => Promise<void>,
    private readonly now: () => number
  ) {}

  /** Returns the hop to run after the response, or null when this denial only adds to a count. */
  add(denial: Denial): Promise<void> | null {
    const minute = utcMinute(this.now());
    const ended: DenialCount[] = [];
    for (const [key, entry] of this.pending) {
      if (entry.minute === minute) continue;
      if (entry.count.count > 0) ended.push(entry.count);
      this.pending.delete(key);
    }

    const distinct = this.pending.size;
    const overflow =
      !this.pending.has(denialKey(denial)) && distinct >= MAX_ISOLATE_DISTINCT_PER_MINUTE;
    const key = overflow ? `overflow:${denial.reason}` : denialKey(denial);
    const entry = this.pending.get(key);
    if (entry !== undefined) {
      entry.count.count += 1;
      return ended.length > 0 ? this.send(ended) : null;
    }
    const recorded: Denial = overflow
      ? { channel: denial.channel, reason: denial.reason, actor: 'overflow', claims: {} }
      : denial;
    this.pending.set(key, { minute, count: { denial: recorded, count: 0, overflow } });
    return this.send([...ended, { denial: recorded, count: 1, overflow }]);
  }
}

const buffers = new Map<string, DenialBuffer>();

/**
 * Counts one refused read in this isolate's buffer and returns the denial-object hop to pass to
 * `waitUntil`, or null. A failed hop is logged: the read is refused either way.
 */
export function recordDenial(env: Env, config: StsConfig, denial: Denial): Promise<void> | null {
  let buffer = buffers.get(config.environment);
  if (buffer === undefined) {
    buffer = new DenialBuffer(
      async counts => {
        try {
          await getDenialStub(env, config).record(counts);
        } catch (error) {
          console.error('sts: bundle denials could not be recorded', {
            denials: counts.length,
            error: error instanceof Error ? error.name : 'unknown',
          });
        }
      },
      () => Date.now()
    );
    buffers.set(config.environment, buffer);
  }
  return buffer.add(denial);
}

/** Test seam: forgets every isolate buffer, so a test's first denial is sent again. */
export function clearDenialBuffers(): void {
  buffers.clear();
}
