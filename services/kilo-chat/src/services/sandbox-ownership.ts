import { getWorkerDb } from '@kilocode/db';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { and, eq, isNull, or } from 'drizzle-orm';
import {
  instanceIdFromSandboxId,
  isInstanceKeyedSandboxId,
  isValidInstanceId,
} from '@kilocode/worker-utils/instance-id';

/**
 * Half-migrated tolerance: a row's `sandbox_id` may still be the legacy
 * userId-derived value while the kiloclaw DO has already moved to the
 * ki_<uuid-hex> form (and the browser/bot path sends the latter). Derive
 * the instance UUID that a ki_-form sandboxId references so callers can
 * OR it into a `kiloclaw_instances.id` match.
 *
 * `isInstanceKeyedSandboxId` only checks prefix + total length, so a value
 * like `ki_<35 chars of non-hex>` would pass through and format into a
 * UUID-shaped string with non-hex characters — comparing that to a uuid
 * column would make Postgres throw `invalid input syntax for type uuid`,
 * turning a 4xx into a 500 on attacker-controlled input. Re-validate the
 * derived UUID; if it fails, return null and skip the id-match branch.
 */
function candidateInstanceIdFromSandboxId(sandboxId: string): string | null {
  if (!isInstanceKeyedSandboxId(sandboxId)) return null;
  const derived = instanceIdFromSandboxId(sandboxId);
  return isValidInstanceId(derived) ? derived : null;
}

async function queryOwnsSandbox(
  connectionString: string,
  userId: string,
  sandboxId: string
): Promise<boolean> {
  const db = getWorkerDb(connectionString);
  const candidateInstanceId = candidateInstanceIdFromSandboxId(sandboxId);
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
  const candidateInstanceId = candidateInstanceIdFromSandboxId(sandboxId);
  const rows = await db
    .select({ user_id: kiloclaw_instances.user_id })
    .from(kiloclaw_instances)
    .where(
      and(
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
