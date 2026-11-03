import { z } from 'zod';

/**
 * Durable capture records (plan "Build admission and execution", steps 8 and 10).
 *
 * A capture is requested with a caller-chosen capture ID. The container DO stores
 * `issued` before it asks the platform for a snapshot and the outcome before it
 * replies, so a caller that lost the reply (a deploy restarts both DOs) reads the
 * result back by ID. An `issued` record whose snapshot call is not running in
 * this isolate any more is `uncertain`: the platform may or may not have taken a
 * snapshot, and the caller must fail that attempt rather than snapshot again.
 * Capture never publishes anything; only the environment coordinator does.
 */

export const CAPTURE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Captures retained per container DO, newest first. Older records are deleted. */
export const MAX_RETAINED_CAPTURES = 8;

const CAPTURE_KEY_PREFIX = 'containers:capture:v1:';
export const CAPTURE_INDEX_KEY = 'containers:captures:v1';

const captureRecordSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('issued'),
      allocationRef: z.string().min(1),
      issuedAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      state: z.literal('stored'),
      allocationRef: z.string().min(1),
      snapshotId: z.string().min(1),
      size: z.number().nonnegative().optional(),
      capturedAt: z.number().int().nonnegative(),
      baseImage: z.string().min(1),
      durationMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      state: z.literal('failed'),
      allocationRef: z.string().min(1),
      reason: z.enum(['not_running', 'abandoned', 'snapshot_failed', 'uncertain']),
    })
    .strict(),
]);

export type CaptureRecord = z.infer<typeof captureRecordSchema>;

/** What a capture caller learns. `in_progress` only while this isolate still awaits it. */
export type NativeCaptureResult =
  | {
      status: 'stored';
      snapshotId: string;
      size?: number;
      capturedAt: number;
      baseImage: string;
      durationMs: number;
    }
  | { status: 'failed'; reason: Extract<CaptureRecord, { state: 'failed' }>['reason'] }
  | { status: 'in_progress' };

export function captureKey(captureId: string): string {
  if (!CAPTURE_ID_PATTERN.test(captureId)) throw new Error('Invalid capture id');
  return `${CAPTURE_KEY_PREFIX}${captureId}`;
}

export function parseCaptureRecord(value: unknown): CaptureRecord | null {
  const parsed = captureRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The caller-facing result of a stored record. `issued` is decided by whether the
 * snapshot call is still in flight in this isolate: if not, nobody can learn its
 * outcome any more.
 */
export function captureResult(record: CaptureRecord, inFlight: boolean): NativeCaptureResult {
  switch (record.state) {
    case 'stored':
      return {
        status: 'stored',
        snapshotId: record.snapshotId,
        ...(record.size === undefined ? {} : { size: record.size }),
        capturedAt: record.capturedAt,
        baseImage: record.baseImage,
        durationMs: record.durationMs,
      };
    case 'failed':
      return { status: 'failed', reason: record.reason };
    case 'issued':
      return inFlight ? { status: 'in_progress' } : { status: 'failed', reason: 'uncertain' };
  }
}

/** The capture index with `captureId` first and the IDs to delete past the retention bound. */
export function retainCaptureIds(
  index: readonly string[],
  captureId: string
): { index: string[]; evicted: string[] } {
  const next = [captureId, ...index.filter(id => id !== captureId)];
  return {
    index: next.slice(0, MAX_RETAINED_CAPTURES),
    evicted: next.slice(MAX_RETAINED_CAPTURES),
  };
}

export function parseCaptureIndex(value: unknown): string[] {
  const parsed = z.array(z.string().regex(CAPTURE_ID_PATTERN)).safeParse(value);
  return parsed.success ? parsed.data : [];
}
