import { z } from 'zod';
import { logger } from '../logger.js';

/**
 * KV `expirationTtl` for one index entry: how long a snapshot nobody uses stays
 * addressable, under the platform's 30-day snapshot lifetime. A snapshot in use is
 * refreshed earlier by the wrapper, from the adopted workspace.
 */
export const REPO_SNAPSHOT_INDEX_TTL_SECONDS = 10 * 24 * 60 * 60;
export const REPO_SNAPSHOT_MAX_START_FAILURES = 10;

const KEY_PREFIX = 'repo-snapshot:v1:';

// `capturedAt` (epoch ms) and `size` are diagnostics only; entries written before
// them lack both, so they stay optional.
const repoSnapshotEntrySchema = z
  .object({
    snapshotId: z.string().min(1),
    commit: z.string().min(1).optional(),
    capturedAt: z.number().optional(),
    size: z.number().optional(),
  })
  .strict();

export type RepoSnapshotEntry = z.infer<typeof repoSnapshotEntrySchema>;

/**
 * The index key for one repository snapshot. `repoKey` is already a keyed hash
 * over the scope and repository (Sandbox DO), so a digest that adds the image,
 * which this DO owns, stays unguessable without this DO holding the key. A deploy
 * that changes the image changes the key, which is how an image-tied snapshot is
 * retired.
 */
export async function repoSnapshotIndexKey(repoKey: string, image: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([repoKey, image]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return KEY_PREFIX + Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The repository snapshot index. Every operation is best effort: an unavailable
 * store is a miss, never a failed start, so a snapshot is an optimisation only.
 */
export type RepoSnapshotIndex = {
  lookup(key: string): Promise<RepoSnapshotEntry | null>;
  store(key: string, entry: RepoSnapshotEntry): Promise<boolean>;
};

export function createRepoSnapshotIndex(kv: KVNamespace | undefined): RepoSnapshotIndex | null {
  if (kv === undefined) return null;
  return {
    async lookup(key) {
      try {
        const raw = await kv.get(key, 'json');
        if (raw === null) return null;
        const parsed = repoSnapshotEntrySchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      } catch (error) {
        warn('lookup', error);
        return null;
      }
    },
    async store(key, entry) {
      try {
        await kv.put(key, JSON.stringify(entry), {
          expirationTtl: REPO_SNAPSHOT_INDEX_TTL_SECONDS,
        });
        return true;
      } catch (error) {
        warn('store', error);
        return false;
      }
    },
  };
}

function warn(operation: string, error: unknown): void {
  logger
    .withFields({
      operation,
      error: error instanceof Error ? error.message : 'unknown',
    })
    .warn('Repository snapshot index unavailable');
}

/** Why one start chose its source. Logged verbatim and never a secret. */
export type StartSourceReason =
  | 'index_unavailable'
  | 'no_repo_key'
  | 'skipped'
  | 'not_allowed'
  | 'index_miss'
  | 'retries_exhausted'
  | 'index_hit';

/**
 * The one start-source rule, shared by the legacy launch path and the native
 * reservation. It decides image vs repository from the snapshot index for the
 * launch's `repoKey` and image, and always has an image fallback, so a start is
 * never blocked by a missing or failed snapshot.
 */
export type StartSourceDecision =
  | { kind: 'image'; reason: Exclude<StartSourceReason, 'index_hit'>; attempts?: number }
  | {
      kind: 'repository';
      reason: 'index_hit';
      snapshotId: string;
      indexKey: string;
      ageMs?: number;
      size?: number;
    };

export async function decideStartSource(input: {
  index: RepoSnapshotIndex | null;
  image: string;
  repoKey: string | undefined;
  skipRepository: boolean;
  allowRepository: boolean;
  failures: { snapshotId: string; attempts: number } | undefined;
}): Promise<StartSourceDecision> {
  if (input.index === null) return { kind: 'image', reason: 'index_unavailable' };
  if (input.repoKey === undefined) return { kind: 'image', reason: 'no_repo_key' };
  const indexKey = await repoSnapshotIndexKey(input.repoKey, input.image);
  if (input.skipRepository) return { kind: 'image', reason: 'skipped' };
  if (!input.allowRepository) return { kind: 'image', reason: 'not_allowed' };
  const entry = await input.index.lookup(indexKey);
  if (entry === null) return { kind: 'image', reason: 'index_miss' };
  const failures = input.failures;
  if (
    failures?.snapshotId === entry.snapshotId &&
    failures.attempts >= REPO_SNAPSHOT_MAX_START_FAILURES
  ) {
    return { kind: 'image', reason: 'retries_exhausted', attempts: failures.attempts };
  }
  // An entry written before `capturedAt` logs no age.
  return {
    kind: 'repository',
    reason: 'index_hit',
    snapshotId: entry.snapshotId,
    indexKey,
    ...(entry.capturedAt === undefined ? {} : { ageMs: Date.now() - entry.capturedAt }),
    ...(entry.size === undefined ? {} : { size: entry.size }),
  };
}
