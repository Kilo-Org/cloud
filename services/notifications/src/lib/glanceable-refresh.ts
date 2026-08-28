import { z } from 'zod';

import { deliverGlanceableSnapshot, type GlanceableDeliveryDeps } from './glanceable-delivery';

const scopeSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1).nullable(),
});

const refreshStateSchema = z.object({
  revision: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  apnsTimestampSeconds: z.number().int().nonnegative(),
  eligibleStartedAt: z.string().datetime().nullable(),
});
const snapshotTimestampsSchema = refreshStateSchema
  .pick({ updatedAt: true, eligibleStartedAt: true })
  .extend({ expiresAt: z.string().datetime() });

/** The user DO owns these records; no ordering or interval state lives in a Worker instance. */
export async function refreshGlanceableSnapshot(
  params: { userId: string; organizationId: string | null },
  storage: DurableObjectStorage,
  deps: GlanceableDeliveryDeps
): Promise<void> {
  const scope = scopeSchema.parse(params);
  const key = `glanceable:${JSON.stringify([scope.userId, scope.organizationId])}`;
  const request = await storage.transaction(async tx => {
    const previous = refreshStateSchema.optional().parse(await tx.get(key));
    const now = Date.now();
    const next = {
      revision: (previous?.revision ?? 0) + 1,
      updatedAt: new Date(
        Math.max(now, previous ? Date.parse(previous.updatedAt) + 1 : now)
      ).toISOString(),
      // APNs orders by whole seconds. Reserve a strict order even for same-second refreshes.
      apnsTimestampSeconds: Math.max(
        Math.floor(now / 1000),
        (previous?.apnsTimestampSeconds ?? 0) + 1
      ),
      eligibleStartedAt: previous?.eligibleStartedAt ?? null,
    };
    await tx.put(key, next);
    return next;
  });

  const snapshot = await deps.buildSnapshot(scope.userId, scope.organizationId);
  // Only the authoritative happy/empty result can change an eligible interval.
  if (snapshot === null || (snapshot.status !== 'happy' && snapshot.status !== 'empty')) return;
  // The shared wire schema accepts strings; validate dates before persisting the interval.
  snapshotTimestampsSchema.parse(snapshot);

  const committed = await storage.transaction(async tx => {
    const current = refreshStateSchema.parse(await tx.get(key));
    if (current.revision !== request.revision) return null;
    const eligibleStartedAt =
      snapshot.running + snapshot.needsInput + snapshot.reconnecting > 0
        ? (current.eligibleStartedAt ?? snapshot.eligibleStartedAt ?? request.updatedAt)
        : null;
    await tx.put(key, { ...current, eligibleStartedAt });
    return {
      ...snapshot,
      revision: request.revision,
      updatedAt: request.updatedAt,
      expiresAt: new Date(
        Date.parse(request.updatedAt) +
          Date.parse(snapshot.expiresAt) -
          Date.parse(snapshot.updatedAt)
      ).toISOString(),
      eligibleStartedAt,
    };
  });
  if (committed === null) return;

  await deliverGlanceableSnapshot(scope, {
    ...deps,
    buildSnapshot: async () => committed,
    apnsTimestampSeconds: request.apnsTimestampSeconds,
    isCurrent: async () => {
      const current = refreshStateSchema.parse(await storage.get(key));
      return current.revision === request.revision;
    },
  });
}
