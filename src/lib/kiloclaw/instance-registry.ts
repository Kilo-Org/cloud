import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { kiloclaw_instances } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { sandboxIdFromInstanceId } from '@/lib/kiloclaw/sandbox-id';

export type ActiveKiloClawInstance = {
  id: string;
  userId: string;
  sandboxId: string;
  organizationId: string | null;
  name: string | null;
};

/**
 * Returns true if this instance row uses the instance-keyed identity scheme
 * (ki_ sandboxId prefix, DO keyed by instanceId). Legacy rows have
 * userId-derived base64url sandboxIds and DOs keyed by userId.
 */
export function isInstanceKeyed(instance: ActiveKiloClawInstance): boolean {
  return instance.sandboxId.startsWith('ki_');
}

/**
 * Returns the instanceId to pass to the worker for DO routing, or undefined
 * for legacy instances (where the DO is keyed by userId, not instanceId).
 *
 * This is the bridge between the Postgres row identity and the worker's
 * instanceStubFactory. Legacy rows must NOT pass instanceId because
 * their DO lives at idFromName(userId), not idFromName(instanceId).
 *
 * Accepts either an ActiveKiloClawInstance (camelCase) or a raw DB row
 * with snake_case fields — checks for both `sandboxId` and `sandbox_id`.
 */
export function workerInstanceId(
  instance: { id: string; sandboxId?: string; sandbox_id?: string } | null | undefined
): string | undefined {
  if (!instance) return undefined;
  const sandboxId = instance.sandboxId ?? instance.sandbox_id;
  if (!sandboxId) return undefined;
  return sandboxId.startsWith('ki_') ? instance.id : undefined;
}

type EnsureActiveInstanceOpts = {
  /** Organization ID. When provided, creates an org-owned instance. */
  orgId?: string;
};

/**
 * Ensure the user has an active KiloClaw registry row before worker provisioning.
 *
 * The returned `id` (DB row UUID) serves as the instanceId for DO keying.
 * sandboxId is always derived from instanceId (`ki_` prefix) for consistency
 * between DB and DO identity. Legacy rows with userId-derived sandboxIds are
 * returned as-is if they already exist.
 *
 * Personal flow: returns existing active row if present, otherwise creates a
 * new instance-keyed row. Idempotent under concurrent calls (second caller
 * sees the first caller's row).
 *
 * Org flow: always creates a new row. Callers must gate on existing rows.
 */
export async function ensureActiveInstance(
  userId: string,
  opts?: EnsureActiveInstanceOpts
): Promise<ActiveKiloClawInstance> {
  const selectFields = {
    id: kiloclaw_instances.id,
    userId: kiloclaw_instances.user_id,
    sandboxId: kiloclaw_instances.sandbox_id,
    organizationId: kiloclaw_instances.organization_id,
    name: kiloclaw_instances.name,
  };

  if (opts?.orgId) {
    // Org instance: generate UUID, derive sandboxId from it.
    // Each call creates a new row (no idempotency — callers gate on existing rows).
    const instanceId = crypto.randomUUID();
    const sandboxId = sandboxIdFromInstanceId(instanceId);

    const [row] = await db
      .insert(kiloclaw_instances)
      .values({
        id: instanceId,
        user_id: userId,
        sandbox_id: sandboxId,
        organization_id: opts.orgId,
      })
      .returning(selectFields);

    if (!row) {
      throw new Error('Failed to create org instance row');
    }

    return row;
  }

  // Personal flow: return existing active row if present.
  // Race note: two concurrent callers can both see no row and both insert.
  // This is benign — getActiveInstance uses ORDER BY created_at ASC so all
  // subsequent reads converge on the oldest row. The second row is an inert
  // orphan (no DO created for it). The window is milliseconds on a user-
  // initiated action already deduplicated by the frontend's useMutation.
  const existing = await getActiveInstance(userId);
  if (existing) return existing;

  // No active row — create a new instance-keyed row.
  // sandboxId = sandboxIdFromInstanceId(uuid) ensures DB and DO identity match.
  const instanceId = crypto.randomUUID();
  const sandboxId = sandboxIdFromInstanceId(instanceId);

  const [row] = await db
    .insert(kiloclaw_instances)
    .values({
      id: instanceId,
      user_id: userId,
      sandbox_id: sandboxId,
    })
    .returning(selectFields);

  if (!row) {
    throw new Error('Failed to create personal instance row');
  }

  return row;
}

/**
 * Soft-delete the active registry row for the user.
 * Returns the affected row so callers can revert on downstream failure.
 *
 * When instanceId is provided, finds the row by its primary key (id) instead
 * of the legacy (userId, sandboxId) lookup. This supports multi-instance
 * where multiple rows may exist for one userId.
 */
export async function markActiveInstanceDestroyed(
  userId: string,
  instanceId?: string
): Promise<ActiveKiloClawInstance | null> {
  const destroyedAt = new Date().toISOString();

  const condition = instanceId
    ? and(eq(kiloclaw_instances.id, instanceId), isNull(kiloclaw_instances.destroyed_at))
    : and(
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_instances.destroyed_at)
      );

  const [row] = await db
    .update(kiloclaw_instances)
    .set({ destroyed_at: destroyedAt })
    .where(condition)
    .returning({
      id: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      sandboxId: kiloclaw_instances.sandbox_id,
      organizationId: kiloclaw_instances.organization_id,
      name: kiloclaw_instances.name,
    });

  return row ?? null;
}

/**
 * Soft-delete a specific instance row by its primary key.
 * Unlike {@link markActiveInstanceDestroyed} (which targets the user's
 * current active row), this targets exactly one row and is safe to use
 * for rollback when the caller knows which row it created.
 */
export async function markInstanceDestroyedById(instanceId: string): Promise<void> {
  await db
    .update(kiloclaw_instances)
    .set({ destroyed_at: new Date().toISOString() })
    .where(and(eq(kiloclaw_instances.id, instanceId), isNull(kiloclaw_instances.destroyed_at)));
}

/**
 * Revert a prior soft-delete (used when downstream destroy fails).
 * The `instanceId` param is the DB row UUID (kiloclaw_instances.id).
 */
export async function restoreDestroyedInstance(instanceId: string): Promise<void> {
  await db
    .update(kiloclaw_instances)
    .set({ destroyed_at: null })
    .where(eq(kiloclaw_instances.id, instanceId));
}

/**
 * Fetch the user's active personal KiloClaw instance (read-only, no upsert).
 *
 * Finds the active row for this user without filtering by sandboxId format.
 * For personal instances there is at most one active row per user (enforced
 * by ensureActiveInstance). For multi-instance (org), use instance-specific
 * lookups instead.
 */
export async function getActiveInstance(userId: string): Promise<ActiveKiloClawInstance | null> {
  const [row] = await db
    .select({
      id: kiloclaw_instances.id,
      userId: kiloclaw_instances.user_id,
      sandboxId: kiloclaw_instances.sandbox_id,
      organizationId: kiloclaw_instances.organization_id,
      name: kiloclaw_instances.name,
    })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .orderBy(kiloclaw_instances.created_at)
    .limit(1);

  return row ?? null;
}

/**
 * Update the display name of the user's active KiloClaw instance.
 * Pass null to clear the name.
 */
export async function renameInstance(userId: string, name: string | null): Promise<void> {
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
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_instances.destroyed_at)
      )
    );

  if (result.rowCount === 0) {
    throw new Error('No active instance found');
  }
}
