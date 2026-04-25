import { getWorkerDb } from '@kilocode/db';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

const TTL_MS = 5 * 60 * 1000;

type CacheEntry =
  | { kind: 'owner'; value: string | null; expiresAt: number }
  | { kind: 'owns'; value: boolean; expiresAt: number };

const cache = new Map<string, CacheEntry>();

function readFresh(key: string): CacheEntry | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry;
}

async function queryOwnsSandbox(
  connectionString: string,
  userId: string,
  sandboxId: string
): Promise<boolean> {
  const db = getWorkerDb(connectionString);
  const rows = await db
    .select({ sandbox_id: kiloclaw_instances.sandbox_id })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .limit(1);
  return rows.length > 0;
}

async function querySandboxOwner(
  connectionString: string,
  sandboxId: string
): Promise<string | null> {
  const db = getWorkerDb(connectionString);
  const rows = await db
    .select({ user_id: kiloclaw_instances.user_id })
    .from(kiloclaw_instances)
    .where(
      and(eq(kiloclaw_instances.sandbox_id, sandboxId), isNull(kiloclaw_instances.destroyed_at))
    )
    .limit(1);
  return rows[0]?.user_id ?? null;
}

/**
 * Returns true if the user owns an active (non-destroyed) instance for the
 * given sandbox. Positive results are cached in-memory for 5 minutes; `false`
 * is treated as a cache miss so a freshly-provisioned sandbox starts
 * returning true as soon as the DB reflects it.
 */
export async function userOwnsSandbox(
  env: Env,
  userId: string,
  sandboxId: string
): Promise<boolean> {
  const key = `owns:${userId}\0${sandboxId}`;
  const hit = readFresh(key);
  if (hit && hit.kind === 'owns') return hit.value;

  const value = await queryOwnsSandbox(env.HYPERDRIVE.connectionString, userId, sandboxId);
  if (value) {
    cache.set(key, { kind: 'owns', value, expiresAt: Date.now() + TTL_MS });
  }
  return value;
}

/**
 * Returns the user_id of the sandbox owner (active, non-destroyed instance),
 * or null if no active instance exists. Resolved owner ids are cached
 * in-memory for 5 minutes; `null` is treated as a cache miss so a
 * freshly-provisioned sandbox resolves its owner on the very next call.
 */
export async function lookupSandboxOwnerUserId(
  env: Env,
  sandboxId: string
): Promise<string | null> {
  const key = `owner:${sandboxId}`;
  const hit = readFresh(key);
  if (hit && hit.kind === 'owner') return hit.value;

  const value = await querySandboxOwner(env.HYPERDRIVE.connectionString, sandboxId);
  if (value !== null) {
    cache.set(key, { kind: 'owner', value, expiresAt: Date.now() + TTL_MS });
  }
  return value;
}

/** Test-only: reset the shared ownership cache. */
export function clearSandboxOwnershipCacheForTest(): void {
  cache.clear();
}
