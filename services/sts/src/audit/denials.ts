import {
  AudienceSchema,
  BUNDLE_DENIED_REASONS,
  MINT_DENIED_REASONS,
  ScopeSchema,
} from '@kilocode/sts-contracts';
import { z } from 'zod';
import { getDenialStub } from '../dos/stubs';
import type { Env, StsConfig } from '../env';

/**
 * Why STS refused a token request: a per-token reason, or a whole call whose identity verified but
 * whose policy does not fit it (`identity_rejected`, `environment_mismatch`).
 */
export const TOKEN_DENIED_REASONS = [
  ...MINT_DENIED_REASONS,
  'identity_rejected',
  'environment_mismatch',
] as const;
export type TokenDeniedReason = (typeof TOKEN_DENIED_REASONS)[number];

type DenialBase = {
  channel: 'worker-binding' | 'http';
  actor: string;
  claims: Record<string, string>;
};

/**
 * A refused bundle read from a caller STS identified: a Worker with valid props, or a provider
 * token whose signature verified. Claims are the provider's stable ids (never the token). `kind`
 * is absent on denials recorded before token denials existed.
 */
export type BundleDenial = DenialBase & {
  kind?: 'bundle';
  reason: (typeof BUNDLE_DENIED_REASONS)[number];
};

/** A refused token from an identified caller; a whole-call refusal names no audience or scope. */
export type TokenDenial = DenialBase & {
  kind: 'token';
  reason: TokenDeniedReason;
  audience?: string;
  scope?: string;
};

export type Denial = BundleDenial | TokenDenial;

/** The longest actor, claim value, audience or scope a denial row holds. */
export const DENIAL_FIELD_MAX_LENGTH = 256;

const DenialBaseSchema = {
  channel: z.enum(['worker-binding', 'http']),
  actor: z.string().min(1).max(DENIAL_FIELD_MAX_LENGTH),
  claims: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.string().max(DENIAL_FIELD_MAX_LENGTH))
    .refine(claims => Object.keys(claims).length <= 16, { message: 'at most 16 claims' }),
};

export const DenialSchema: z.ZodType<Denial> = z.union([
  z.strictObject({
    ...DenialBaseSchema,
    kind: z.literal('bundle').optional(),
    reason: z.enum(BUNDLE_DENIED_REASONS),
  }),
  z.strictObject({
    ...DenialBaseSchema,
    kind: z.literal('token'),
    reason: z.enum(TOKEN_DENIED_REASONS),
    audience: AudienceSchema.max(DENIAL_FIELD_MAX_LENGTH).optional(),
    scope: ScopeSchema.max(DENIAL_FIELD_MAX_LENGTH).optional(),
  }),
]);

/** Identical denials in one minute merge into one row; this is the identity they merge on. */
export function denialKey(denial: Denial): string {
  const claims = Object.keys(denial.claims)
    .sort()
    .map(name => [name, denial.claims[name]]);
  if (denial.kind === 'token') {
    return JSON.stringify([
      'token',
      denial.channel,
      denial.reason,
      denial.actor,
      denial.audience ?? null,
      denial.scope ?? null,
      claims,
    ]);
  }
  return JSON.stringify([denial.channel, denial.reason, denial.actor, claims]);
}

/** The row that counts a reason's denials past the per-minute distinct limit. */
export function overflowKey(denial: Denial): string {
  return denial.kind === 'token' ? `overflow:token:${denial.reason}` : `overflow:${denial.reason}`;
}

/** What an overflow row records: the kind, channel and reason, no actor details. */
export function overflowDenial(denial: Denial): Denial {
  const base = { channel: denial.channel, actor: 'overflow', claims: {} };
  return denial.kind === 'token'
    ? { ...base, kind: 'token', reason: denial.reason }
    : { ...base, reason: denial.reason };
}

/** Distinct denials one isolate sends per minute before it counts the rest as overflow. */
export const MAX_ISOLATE_DISTINCT_PER_MINUTE = 100;

/**
 * Denials sent in one record call: `count` occurrences of `denial` (or of its reason when
 * `overflow`) in the UTC minute `minute` (`YYYY-MM-DDTHH:MM`) they happened in.
 */
export type DenialCount = { denial: Denial; count: number; overflow: boolean; minute: string };

/** After a failed send an isolate only counts for this long, doubling per failure up to the cap. */
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 60_000;

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
function entryKey(count: { denial: Denial; overflow: boolean }): string {
  return count.overflow ? overflowKey(count.denial) : denialKey(count.denial);
}

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
 * replayed token costs no hop at all after its first use. The denials of one request (a mint call
 * refused for several audiences) go out in one hop. A failed send gives its counts back and
 * starts a backoff (10 s, doubling to 60 s, reset by a success) during which every denial is only
 * counted; the first denial after it sends everything held. So an isolate makes at most one hop
 * per backoff period while the denial object fails. Past `MAX_ISOLATE_DISTINCT_PER_MINUTE` distinct
 * denials a minute, further ones are counted per kind and reason as overflow. Counts still pending
 * when the isolate ends are lost.
 */
export class DenialBuffer {
  private readonly pending = new Map<string, Pending>();
  /** Ended or returned counts for the next hop, keyed by minute and denial. */
  private retry = new Map<string, DenialCount>();
  private failures = 0;
  private holdUntil = 0;

  constructor(
    private readonly send: (counts: DenialCount[]) => Promise<void>,
    private readonly now: () => number,
    private readonly onFailure: (error: unknown, counts: DenialCount[]) => void = () => {}
  ) {}

  /**
   * Returns the hop to run after the response, or null when these denials only add to counts.
   * While a backoff after a failed send runs, every denial is only counted.
   */
  add(...denials: Denial[]): Promise<void> | null {
    const now = this.now();
    const minute = utcMinute(now);
    for (const [key, entry] of this.pending) {
      if (entry.minute === minute) continue;
      if (entry.unsent > 0) this.keep(this.countOf(entry));
      this.pending.delete(key);
    }

    for (const denial of denials) {
      const overflow =
        !this.pending.has(denialKey(denial)) &&
        this.pending.size >= MAX_ISOLATE_DISTINCT_PER_MINUTE;
      const key = overflow ? overflowKey(denial) : denialKey(denial);
      let entry = this.pending.get(key);
      if (entry === undefined) {
        const recorded = overflow ? overflowDenial(denial) : denial;
        entry = { minute, denial: recorded, overflow, unsent: 0, sent: false };
        this.pending.set(key, entry);
      }
      entry.unsent += 1;
    }
    if (now < this.holdUntil) return null;

    // Ended counts, the new entries, and any a failed send gave back go out with this hop.
    const batch = [...this.retry.values()];
    this.retry.clear();
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
      this.failures = 0;
      this.holdUntil = 0;
    } catch (error) {
      this.failures += 1;
      this.holdUntil =
        this.now() + Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (this.failures - 1));
      this.onFailure(error, batch);
      for (const count of batch) this.restore(count);
    }
  }

  /** Holds an ended or returned count for the next hop, merged with one for the same minute. */
  private keep(count: DenialCount): void {
    const key = `${count.minute}\n${entryKey(count)}`;
    const held = this.retry.get(key);
    if (held !== undefined) held.count += count.count;
    else if (this.retry.size < MAX_RETRY_ENTRIES) this.retry.set(key, count);
  }

  private restore(count: DenialCount): void {
    const entry = this.pending.get(entryKey(count));
    if (entry !== undefined && entry.minute === count.minute) {
      entry.unsent += count.count;
      entry.sent = false;
      return;
    }
    this.keep(count);
  }
}

const buffers = new Map<string, DenialBuffer>();

/**
 * Counts refused requests in this isolate's buffer and returns the one denial-object hop to pass
 * to `waitUntil`, or null. A failed hop is logged and its counts are kept for the next hop: the
 * request is refused either way. A denial the denial object would refuse (`DenialSchema`) is
 * logged and dropped here, so it never makes the valid denials of its hop, or of later hops it
 * would be retried with, fail too.
 */
export function recordDenial(
  env: Env,
  config: StsConfig,
  ...denials: Denial[]
): Promise<void> | null {
  const recordable = denials.filter(denial => {
    if (DenialSchema.safeParse(denial).success) return true;
    console.error('sts: denial does not fit a denial row; dropped', {
      kind: denial.kind ?? 'bundle',
      reason: denial.reason,
    });
    return false;
  });
  if (recordable.length === 0) return null;
  let buffer = buffers.get(config.environment);
  if (buffer === undefined) {
    buffer = new DenialBuffer(
      counts => getDenialStub(env, config).record(counts),
      () => Date.now(),
      (error, counts) => {
        console.error('sts: denials could not be recorded; kept for the next hop', {
          denials: counts.length,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    );
    buffers.set(config.environment, buffer);
  }
  return buffer.add(...recordable);
}

/** Test seam: forgets every isolate buffer, so a test's first denial is sent again. */
export function clearDenialBuffers(): void {
  buffers.clear();
}
