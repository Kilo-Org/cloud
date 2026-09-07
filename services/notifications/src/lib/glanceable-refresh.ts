import { GLANCEABLE_SNAPSHOT_EXPIRY_MS } from '@kilocode/app-shared/glanceable-agents-snapshot';
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
});
// `needsInputSince` comes from the session rows on every build, so no eligible
// interval is carried across revisions and only the dates are validated here.
const snapshotTimestampsSchema = refreshStateSchema
  .pick({ updatedAt: true })
  .extend({ expiresAt: z.string().datetime(), needsInputSince: z.string().datetime().nullable() });

/** The user DO owns these records; no ordering or interval state lives in a Worker instance. */
export async function refreshGlanceableSnapshot(
  params: { userId: string; organizationId: string | null },
  storage: DurableObjectStorage,
  deps: GlanceableDeliveryDeps
): Promise<void> {
  const scope = scopeSchema.parse(params);
  const key = `glanceable:${JSON.stringify([scope.userId, scope.organizationId])}`;
  // Row renewal or temporary absence cannot prove that the native token is live.
  const iosEndPrefix = (token: string) => `glanceable-ios-end:${JSON.stringify(token)}:`;
  // A card raised by push-to-start carries no update token until the app runs
  // and adopts it, so nothing here can update or end it. Without this fence
  // every later refresh raises another card and the Lock Screen stacks them.
  const iosStartPrefix = 'glanceable-ios-start:';
  const iosStartKey = (token: string) => `${iosStartPrefix}${JSON.stringify(token)}`;
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
    };
    await tx.put(key, next);
    return next;
  });

  const snapshot = await deps.buildSnapshot(scope.userId, scope.organizationId);
  // Only the authoritative happy/empty result can change an eligible interval.
  if (snapshot === null || (snapshot.status !== 'happy' && snapshot.status !== 'empty')) return;
  // The shared wire schema accepts strings; validate the dates before delivery.
  snapshotTimestampsSchema.parse(snapshot);

  const committed = await storage.transaction(async tx => {
    const current = refreshStateSchema.parse(await tx.get(key));
    if (current.revision !== request.revision) return null;
    return {
      ...snapshot,
      revision: request.revision,
      updatedAt: request.updatedAt,
      expiresAt: new Date(
        Date.parse(request.updatedAt) +
          Date.parse(snapshot.expiresAt) -
          Date.parse(snapshot.updatedAt)
      ).toISOString(),
    };
  });
  if (committed === null) return;

  const eligible = committed.running + committed.needsInput + committed.idle > 0;
  await deliverGlanceableSnapshot(scope, {
    ...deps,
    buildSnapshot: async () => committed,
    apnsTimestampSeconds: request.apnsTimestampSeconds,
    isCurrent: async () => {
      const current = refreshStateSchema.parse(await storage.get(key));
      return current.revision === request.revision;
    },
    listIosActivityTokens: async (userId, organizationId) => {
      const tokens = await deps.listIosActivityTokens(userId, organizationId);
      const current = refreshStateSchema.parse(await storage.get(key));
      if (current.revision !== request.revision) return [];
      const withoutFencedStarts = await dropFencedStarts(tokens, storage, {
        prefix: iosStartPrefix,
        key: iosStartKey,
      });
      // Empty work can retry ends. Eligible work excludes every accepted or uncertain end.
      if (!eligible) return withoutFencedStarts;
      const retiring = await Promise.all(
        withoutFencedStarts.map(async ({ token, kind }) =>
          kind === 'ios_activity'
            ? (await storage.list({ prefix: iosEndPrefix(token), limit: 1 })).size > 0
            : false
        )
      );
      return withoutFencedStarts.filter((_, index) => !retiring[index]);
    },
    onIosStarted: async token => {
      // Hold the fence for the whole maximum life of the card it raised. An
      // orphan card cannot be ended remotely, so a second one would simply sit
      // beside it until ActivityKit dismisses them both.
      await storage.put(iosStartKey(token), Date.now() + GLANCEABLE_SNAPSHOT_EXPIRY_MS);
    },
    beforeIosEnd: async token => {
      return storage.transaction(async tx => {
        const current = refreshStateSchema.parse(await tx.get(key));
        if (current.revision !== request.revision) return false;
        // Each revision sends at most one end per token. Keep its obligation separate.
        await tx.put(`${iosEndPrefix(token)}${key}:${request.revision}`, true);
        return true;
      });
    },
    onIosEndRejected: async token => {
      // A delayed rejection releases only its attempt, not another pending or accepted end.
      await storage.delete(`${iosEndPrefix(token)}${key}:${request.revision}`);
    },
  });
}

/**
 * Drop the push-to-start tokens that already raised a card nobody has adopted.
 *
 * An `ios_activity` row proves the app adopted its card, so it owns duplicate
 * retirement from here and every fence in the scope is released. Otherwise a
 * push-to-start whose fence has not lapsed is removed from the list, which
 * leaves `apnsSendsForTokens` with no start to send.
 *
 * Every read also drops the lapsed fences, including those of tokens the device
 * has since rotated away and will never present again.
 */
async function dropFencedStarts<T extends { token: string; kind: string }>(
  tokens: readonly T[],
  storage: DurableObjectStorage,
  fence: { prefix: string; key: (token: string) => string }
): Promise<T[]> {
  const held = await storage.list<number>({ prefix: fence.prefix });
  if (tokens.some(({ kind }) => kind === 'ios_activity')) {
    if (held.size > 0) {
      await storage.delete([...held.keys()]);
    }
    return [...tokens];
  }
  const now = Date.now();
  const lapsed = [...held].filter(([, until]) => until <= now).map(([key]) => key);
  if (lapsed.length > 0) {
    await storage.delete(lapsed);
  }
  return tokens.filter(({ token, kind }) => {
    const until = held.get(fence.key(token));
    return kind !== 'ios_push_to_start' || until === undefined || until <= now;
  });
}
