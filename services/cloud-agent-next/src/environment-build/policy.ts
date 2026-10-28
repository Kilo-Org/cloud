import { z } from 'zod';
import {
  environmentOwnerSchema,
  environmentRepositoryIdentitySchema,
  sameEnvironmentScope,
  type SessionEnvironmentReference,
} from './reference.js';

/**
 * Build and snapshot policy (plan "Ownership and data", "Build admission and
 * execution", "Session launch"). Pure decisions over persisted records, so the
 * coordinator, the status view and tests share one owner for each rule.
 */

/** Absolute bound of one build, including allocation and capture. */
export const BUILD_DEADLINE_MS = 30 * 60_000;
/** A published snapshot older than this is stale and admits a replacement. */
export const SNAPSHOT_STALE_AFTER_MS = 4 * 24 * 60 * 60_000;
/**
 * Cloudflare documents a 30-day snapshot TTL, refreshed on restore. A
 * descriptor is ineligible a day earlier, so a start never races the expiry.
 */
export const SNAPSHOT_PLATFORM_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const SNAPSHOT_ELIGIBLE_LIFETIME_MS = SNAPSHOT_PLATFORM_LIFETIME_MS - 24 * 60 * 60_000;
/** A preparing builder with no report for this long is lost. */
export const BUILDER_REPORT_LOSS_MS = 90_000;
/** A started builder has this long to make its first report. */
export const BUILDER_FIRST_REPORT_MS = 5 * 60_000;
/** Terminal build records retained; the published descriptor is kept separately. */
export const MAX_TERMINAL_BUILDS = 20;
export const BUILD_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Redacted log bytes kept per build. */
export const MAX_BUILD_LOG_BYTES = 1024 * 1024;
/** Session snapshot lookup budget, including retries. */
export const SNAPSHOT_LOOKUP_BUDGET_MS = 15_000;
/** Alarm cadence while a builder runs. */
export const PREPARING_TICK_MS = 30_000;
/** Stop retries back off up to this interval and continue until confirmed. */
export const CLEANUP_RETRY_MAX_MS = 5 * 60_000;
export const CLEANUP_ATTEMPTS_BEFORE_FAILURE = 5;

export const publishedSnapshotSchema = z
  .object({
    buildId: z.string().uuid(),
    environmentId: z.string().uuid(),
    owner: environmentOwnerSchema,
    revision: z.number().int().positive(),
    repository: environmentRepositoryIdentitySchema,
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
    sourceBranch: z.string().min(1).max(256),
    provider: z.literal('cloudflare-containers'),
    baseImage: z.string().min(1),
    runtimeAbi: z.string().min(1),
    runtimeRelease: z.string().min(1).nullable(),
    builderInstance: z.string().min(1),
    snapshotId: z.string().min(1),
    size: z.number().nonnegative().optional(),
    capturedAt: z.number().int().nonnegative(),
    publishedAt: z.number().int().nonnegative(),
    setupDurationMs: z.number().int().nonnegative(),
  })
  .strict();
export type PublishedSnapshot = z.infer<typeof publishedSnapshotSchema>;

/**
 * The launch image and runtime ABI a session would start with now. `baseImage`
 * is null when it could not be read; the container DO still refuses another
 * image, so an unknown image never blocks a start.
 */
export type SnapshotCompatibility = {
  baseImage: string | null;
  runtimeAbi: string;
  runtimeMode: 'preinstalled' | 'downloaded';
};

/** Whether `published` can start under `current` (plan "Session launch"). */
export function compatibleWith(
  published: PublishedSnapshot,
  current: SnapshotCompatibility
): boolean {
  return (
    published.runtimeAbi === current.runtimeAbi &&
    (current.runtimeMode === 'downloaded' || published.runtimeRelease === null) &&
    (current.baseImage === null || published.baseImage === current.baseImage)
  );
}

/** Why a snapshot is not used for a session, or `eligible`. */
export type SnapshotEligibility =
  | { eligible: true; stale: false }
  | { eligible: true; stale: true; staleReason: 'revision' | 'age' }
  | {
      eligible: false;
      reason: 'missing' | 'scope_mismatch' | 'incompatible' | 'newer_than_session' | 'expired';
    };

/**
 * Whether a session admitted at `reference` may start from `published`. An
 * older revision or an age-stale snapshot stays usable while its replacement
 * builds; a newer one must not introduce later setup into an older session.
 * A snapshot for another base image or runtime ABI is incompatible. Instance
 * size and runtime release are not part of compatibility.
 */
export function snapshotEligibility(
  published: PublishedSnapshot | null,
  reference: SessionEnvironmentReference,
  now: number,
  current: SnapshotCompatibility
): SnapshotEligibility {
  if (published === null) return { eligible: false, reason: 'missing' };
  if (!sameEnvironmentScope(published, reference)) {
    return { eligible: false, reason: 'scope_mismatch' };
  }
  if (!compatibleWith(published, current)) return { eligible: false, reason: 'incompatible' };
  if (published.revision > reference.configurationRevision) {
    return { eligible: false, reason: 'newer_than_session' };
  }
  if (now - published.capturedAt >= SNAPSHOT_ELIGIBLE_LIFETIME_MS) {
    return { eligible: false, reason: 'expired' };
  }
  if (published.revision < reference.configurationRevision) {
    return { eligible: true, stale: true, staleReason: 'revision' };
  }
  if (now - published.capturedAt >= SNAPSHOT_STALE_AFTER_MS) {
    return { eligible: true, stale: true, staleReason: 'age' };
  }
  return { eligible: true, stale: false };
}

/** Whether `revision` needs a replacement build: no usable or no current snapshot. */
export function replacementNeeded(
  published: PublishedSnapshot | null,
  revision: number,
  now: number,
  current: SnapshotCompatibility
): boolean {
  if (published === null || published.revision !== revision) return true;
  if (!compatibleWith(published, current)) return true;
  return now - published.capturedAt >= SNAPSHOT_STALE_AFTER_MS;
}

export type AutoAttempt = {
  failures: number;
  lastFailureAt: number | null;
  lastAdmittedAt: number | null;
};

const BACKOFF_AFTER_FAILURES_MS = [0, 10 * 60_000, 60 * 60_000] as const;
const LONG_BACKOFF_MS = 24 * 60 * 60_000;

/**
 * Automatic admission backoff for one revision (proposed values): the first
 * attempt is free; after one failure a later session may admit after 10
 * minutes, after two after 1 hour, and after three or more at most one
 * automatic build per 24 hours. A manual Build is never subject to this.
 */
export function automaticAdmission(
  attempt: AutoAttempt | null,
  now: number
): { admit: true } | { admit: false; retryAt: number } {
  if (attempt === null || attempt.failures === 0) return { admit: true };
  if (attempt.failures < BACKOFF_AFTER_FAILURES_MS.length) {
    const retryAt =
      (attempt.lastFailureAt ?? 0) + (BACKOFF_AFTER_FAILURES_MS[attempt.failures] ?? 0);
    return now >= retryAt ? { admit: true } : { admit: false, retryAt };
  }
  const retryAt =
    Math.max(attempt.lastFailureAt ?? 0, attempt.lastAdmittedAt ?? 0) + LONG_BACKOFF_MS;
  return now >= retryAt ? { admit: true } : { admit: false, retryAt };
}

/** Builder failure reasons that count toward automatic backoff; admission refusals do not. */
export const COUNTED_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'clone_failed',
  'setup_failed',
  'setup_timeout',
  'cleanup_failed',
  'capture_failed',
  'capture_uncertain',
  'deadline',
  'builder_lost',
  'builder_start_failed',
  'input_unavailable',
]);

/** Stop retry delay after `attempts` unconfirmed stops. */
export function cleanupRetryDelay(attempts: number): number {
  return Math.min(CLEANUP_RETRY_MAX_MS, 5_000 * 2 ** Math.max(0, attempts - 1));
}
