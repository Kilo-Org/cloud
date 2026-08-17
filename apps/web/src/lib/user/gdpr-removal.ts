import { captureException } from '@sentry/nextjs';
import { createKiloClawAdminAuditLog } from '@/lib/kiloclaw/admin-audit-log';
import {
  listAllActiveInstanceRows,
  markActiveInstanceBatchDestroyedForGdpr,
  restoreGdprDestroyedInstanceBatch,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { softDeleteUserExternalServices } from '@/lib/external-services';
import { assertUserCanBeSoftDeleted, findUserById, softDeleteUser } from '@/lib/user';

export type GdprRemovalActor = {
  id: string;
  email: string;
  name?: string | null;
};

export async function performGdprRemoval(
  userId: string,
  options: {
    destroyReason: 'admin_request';
    actor: GdprRemovalActor;
  }
): Promise<{ warnings: string[] }> {
  await assertUserCanBeSoftDeleted(userId);

  const user = await findUserById(userId);

  const groups = new Map<string, { instanceIds: string[]; workerInstanceId?: string }>();
  for (const instance of await listAllActiveInstanceRows(userId)) {
    const instanceId = workerInstanceId(instance);
    const key = instanceId ?? 'legacy';
    const group = groups.get(key) ?? { instanceIds: [], workerInstanceId: instanceId };
    group.instanceIds.push(instance.id);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const batch = await markActiveInstanceBatchDestroyedForGdpr(userId, group.instanceIds);
    try {
      await new KiloClawInternalClient().destroy(userId, group.workerInstanceId, {
        reason: options.destroyReason,
      });
    } catch (error) {
      try {
        await restoreGdprDestroyedInstanceBatch(batch);
      } catch (rollbackError) {
        captureException(rollbackError, {
          tags: { source: 'gdpr-removal', operation: 'restore-instance-batch' },
          extra: { userId, instanceIds: batch.instanceIds },
        });
      }
      throw error;
    }

    try {
      await createKiloClawAdminAuditLog({
        action: 'kiloclaw.instance.destroy',
        actor_id: options.actor.id,
        actor_email: options.actor.email,
        actor_name: options.actor.name ?? null,
        target_user_id: userId,
        message: 'KiloClaw instance destroyed for GDPR removal',
        metadata: {
          instanceIds: group.instanceIds,
          workerInstanceId: group.workerInstanceId ?? null,
          reason: options.destroyReason,
        },
      });
    } catch (auditError) {
      captureException(auditError, {
        tags: { source: 'gdpr-removal', operation: 'kiloclaw-admin-audit' },
        extra: { userId, instanceIds: group.instanceIds },
      });
    }
  }

  await softDeleteUser(userId);

  if (!user) {
    return { warnings: [] };
  }

  const warnings = await softDeleteUserExternalServices(user);
  return { warnings };
}
