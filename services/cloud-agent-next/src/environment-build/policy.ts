import { z } from 'zod';
import {
  environmentOwnerSchema,
  environmentRepositoryIdentitySchema,
  sameEnvironmentScope,
  type EnvironmentScope,
} from './reference.js';
import { environmentBuildMemberPinSchema } from '../shared/environment-build-protocol.js';
import { sameVercelAccount } from '../byoc/vercel-snapshot-compatibility.js';

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

const publishedSnapshotCommonSchema = z.object({
  buildId: z.string().uuid(),
  environmentId: z.string().uuid(),
  owner: environmentOwnerSchema,
  revision: z.number().int().positive(),
  provider: z.enum(['cloudflare-containers', 'vercel']),
  baseImage: z.string().min(1),
  runtimeAbi: z.string().min(1),
  runtimeRelease: z.string().min(1).nullable(),
  builderInstance: z.string().min(1),
  snapshotId: z.string().min(1),
  size: z.number().nonnegative().optional(),
  capturedAt: z.number().int().nonnegative(),
  publishedAt: z.number().int().nonnegative(),
  setupDurationMs: z.number().int().nonnegative(),
});

/**
 * A published descriptor has two exclusive alternatives. A singleton descriptor
 * stores `repository`, `sourceCommit`, and `sourceBranch`. A V2 descriptor
 * stores one pin for each repository and leaves `sourceCommit` and
 * `sourceBranch` null; it does not copy one repository into `repository` or
 * `sourceCommit`.
 */
export const publishedSnapshotSchema = z.union([
  publishedSnapshotCommonSchema
    .extend({
      repository: environmentRepositoryIdentitySchema,
      sourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
      sourceBranch: z.string().min(1).max(256),
      repositories: z.undefined().optional(),
    })
    .strict(),
  publishedSnapshotCommonSchema
    .extend({
      repositories: z
        .array(
          environmentBuildMemberPinSchema.extend({
            identity: environmentRepositoryIdentitySchema,
          })
        )
        .min(1),
      repository: z.undefined().optional(),
      sourceCommit: z.null().optional(),
      sourceBranch: z.null().optional(),
    })
    .strict(),
]);
export type PublishedSnapshot = z.infer<typeof publishedSnapshotSchema>;

/**
 * The provider, account/base identity and runtime ABI a session would start
 * with now. `baseImage` is null when it could not be read. For native containers
 * the container DO still refuses another image, so an unknown image never
 * blocks a start. Vercel has no such guard: an account that cannot be read is
 * incompatible, because restoring across accounts is never safe.
 */
export type SnapshotCompatibility = {
  provider: PublishedSnapshot['provider'];
  baseImage: string | null;
  runtimeAbi: string;
};

/** How a published snapshot's base image relates to the image a session would use now. */
export type SnapshotImageCompatibility = 'current' | 'previous' | 'incompatible';

/**
 * Only snapshots from the same provider, with the same runtime ABI and a
 * downloaded runtime, can serve sessions. A snapshot from an earlier base image
 * stays usable while its replacement builds: the current runtime is installed
 * over the restored disk, so only the base userspace and installed tools
 * differ. A Vercel snapshot must also come from the same account, and an
 * unreadable account is incompatible because restoring across accounts is
 * never safe.
 */
export function snapshotImageCompatibility(
  published: PublishedSnapshot,
  current: SnapshotCompatibility
): SnapshotImageCompatibility {
  if (published.provider !== current.provider) return 'incompatible';
  if (published.runtimeAbi !== current.runtimeAbi) return 'incompatible';
  if (published.provider === 'cloudflare-containers' && published.runtimeRelease === null) {
    return 'incompatible';
  }
  if (current.baseImage === null) {
    return published.provider === 'vercel' ? 'incompatible' : 'current';
  }
  if (published.baseImage === current.baseImage) return 'current';
  if (published.provider === 'vercel' && !sameVercelAccount(published.baseImage, current.baseImage))
    return 'incompatible';
  return 'previous';
}

export function compatibleWith(
  published: PublishedSnapshot,
  current: SnapshotCompatibility
): boolean {
  return snapshotImageCompatibility(published, current) !== 'incompatible';
}

/** Why a snapshot is not used for a session, or `eligible`. */
export type SnapshotEligibility =
  | { eligible: true; stale: false }
  | { eligible: true; stale: true; staleReason: 'revision' | 'age' | 'image' }
  | {
      eligible: false;
      reason: 'missing' | 'scope_mismatch' | 'incompatible' | 'newer_than_session' | 'expired';
    };

/**
 * Whether a session admitted at `reference` may start from `published`. An
 * older revision or an age-stale snapshot stays usable while its replacement
 * builds; a newer one must not introduce later setup into an older session.
 * A snapshot for an earlier base image stays usable until it expires, and
 * another runtime ABI is always incompatible. Instance size and
 * runtime release are not part of compatibility.
 */
export function snapshotEligibility(
  published: PublishedSnapshot | null,
  reference: EnvironmentScope,
  now: number,
  current: SnapshotCompatibility
): SnapshotEligibility {
  if (published === null) return { eligible: false, reason: 'missing' };
  if (!sameEnvironmentScope(published, reference)) {
    return { eligible: false, reason: 'scope_mismatch' };
  }
  const image = snapshotImageCompatibility(published, current);
  if (image === 'incompatible') return { eligible: false, reason: 'incompatible' };
  if (published.revision > reference.configurationRevision) {
    return { eligible: false, reason: 'newer_than_session' };
  }
  if (now - published.capturedAt >= SNAPSHOT_ELIGIBLE_LIFETIME_MS) {
    return { eligible: false, reason: 'expired' };
  }
  if (image === 'previous') {
    return { eligible: true, stale: true, staleReason: 'image' };
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
  if (snapshotImageCompatibility(published, current) !== 'current') return true;
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

/** Builder failures and container-cap refusals count toward automatic backoff; other admission refusals do not. */
export const COUNTED_FAILURE_REASONS: ReadonlySet<string> = new Set([
  'container_limit_reached',
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
