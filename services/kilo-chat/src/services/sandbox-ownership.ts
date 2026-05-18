import { getWorkerDb } from '@kilocode/db';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import {
  instanceIdFromSandboxId,
  isInstanceKeyedSandboxId,
  isValidInstanceId,
} from '@kilocode/worker-utils/instance-id';

async function queryOwnsSandbox(
  connectionString: string,
  userId: string,
  sandboxId: string
): Promise<boolean> {
  const db = getWorkerDb(connectionString);
  // Half-migrated tolerance: a row's `sandbox_id` may still be the legacy
  // userId-derived value while the kiloclaw DO has already moved to the
  // ki_<uuid-hex> form (and the browser sends the latter). Accept the ki_
  // form by matching against `id` so ownership keeps working across the
  // migration window. Ownership is still strictly scoped to the caller's
  // own active rows (user_id + destroyed_at filters are unchanged).
  // `isInstanceKeyedSandboxId` only checks prefix + total length, so a value
  // like `ki_<35 chars of non-hex>` would pass through and then format into
  // a UUID-shaped string with non-hex characters — comparing that to a uuid
  // column would make Postgres throw `invalid input syntax for type uuid`,
  // turning a 403 into a 500 on attacker-controlled input. Re-validate the
  // derived UUID and skip the id-match branch if it doesn't pass.
  const derivedInstanceId = isInstanceKeyedSandboxId(sandboxId)
    ? instanceIdFromSandboxId(sandboxId)
    : null;
  const candidateInstanceId =
    derivedInstanceId && isValidInstanceId(derivedInstanceId) ? derivedInstanceId : null;
  const rows = await db
    .select({ sandbox_id: kiloclaw_instances.sandbox_id })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.destroyed_at),
        candidateInstanceId
          ? or(
              eq(kiloclaw_instances.sandbox_id, sandboxId),
              eq(kiloclaw_instances.id, candidateInstanceId)
            )
          : eq(kiloclaw_instances.sandbox_id, sandboxId)
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
 * given sandbox.
 */
export async function userOwnsSandbox(
  env: Env,
  userId: string,
  sandboxId: string
): Promise<boolean> {
  return await queryOwnsSandbox(env.HYPERDRIVE.connectionString, userId, sandboxId);
}

/**
 * Returns the user_id of the sandbox owner (active, non-destroyed instance),
 * or null if no active instance exists.
 */
export async function lookupSandboxOwnerUserId(
  env: Env,
  sandboxId: string
): Promise<string | null> {
  return await querySandboxOwner(env.HYPERDRIVE.connectionString, sandboxId);
}
