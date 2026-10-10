import { z } from 'zod';
import { logger } from '../logger.js';

/**
 * KV `expirationTtl` for one index entry: how long a snapshot nobody uses stays
 * addressable, under the platform's 30-day snapshot lifetime. A snapshot in use is
 * refreshed earlier by the wrapper, from the adopted workspace.
 */
export const REPO_SNAPSHOT_INDEX_TTL_SECONDS = 10 * 24 * 60 * 60;

const KEY_PREFIX = 'repo-snapshot:v1:';

const repoSnapshotEntrySchema = z
  .object({
    snapshotId: z.string().min(1),
    commit: z.string().min(1).optional(),
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
  remove(key: string): Promise<void>;
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
    async remove(key) {
      try {
        await kv.delete(key);
      } catch (error) {
        warn('remove', error);
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
