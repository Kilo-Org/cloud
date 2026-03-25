import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { sandboxIdFromUserId } from '@/lib/kiloclaw/sandbox-id';

export type ActiveKiloClawInstance = {
  id: string;
  userId: string;
  sandboxId: string;
  name: string | null;
};

/**
 * Ensure the user has an active KiloClaw registry row before worker provisioning.
 * This is idempotent and safe under concurrent calls.
 */
export async function ensureActiveInstance(userId: string): Promise<ActiveKiloClawInstance> {
  const sandboxId = sandboxIdFromUserId(userId);

  await db
    .insert(kiloclaw_instances)
    .values({
      user_id: userId,
      sandbox_id: sandboxId,
    })
    .onConflictDoNothing();

  const [row] = await db
    .select({
      id: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      sandboxId: kiloclaw_instances.sandbox_id,
      name: kiloclaw_instances.name,
    })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .limit(1);

  if (!row) {
    throw new Error('Failed to ensure active KiloClaw instance row');
  }

  return row;
}

/**
 * Soft-delete the active registry row for the user.
 * Returns the affected row so callers can revert on downstream failure.
 */
export async function markActiveInstanceDestroyed(
  userId: string
): Promise<ActiveKiloClawInstance | null> {
  const sandboxId = sandboxIdFromUserId(userId);
  const destroyedAt = new Date().toISOString();

  const [row] = await db
    .update(kiloclaw_instances)
    .set({ destroyed_at: destroyedAt })
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .returning({
      id: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      sandboxId: kiloclaw_instances.sandbox_id,
      name: kiloclaw_instances.name,
    });

  return row ?? null;
}

/**
 * Revert a prior soft-delete (used when downstream destroy fails).
 */
export async function restoreDestroyedInstance(instanceId: string): Promise<void> {
  await db
    .update(kiloclaw_instances)
    .set({ destroyed_at: null })
    .where(eq(kiloclaw_instances.id, instanceId));
}

/**
 * Fetch the user's active KiloClaw instance (read-only, no upsert).
 */
export async function getActiveInstance(userId: string): Promise<ActiveKiloClawInstance | null> {
  const sandboxId = sandboxIdFromUserId(userId);

  const [row] = await db
    .select({
      id: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      sandboxId: kiloclaw_instances.sandbox_id,
      name: kiloclaw_instances.name,
    })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .limit(1);

  return row ?? null;
}

/**
 * Update the display name of the user's active KiloClaw instance.
 * Pass null to clear the name.
 */
export async function renameInstance(userId: string, name: string | null): Promise<void> {
  const sandboxId = sandboxIdFromUserId(userId);
  const trimmed = name?.trim() || null;

  if (trimmed !== null && trimmed.length > 50) {
    throw new Error('Instance name must be 50 characters or fewer');
  }

  const result = await db
    .update(kiloclaw_instances)
    .set({ name: trimmed })
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        eq(kiloclaw_instances.sandbox_id, sandboxId),
        isNull(kiloclaw_instances.destroyed_at)
      )
    );

  if (result.rowCount === 0) {
    throw new Error('No active instance found');
  }
}
