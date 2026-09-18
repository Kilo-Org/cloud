import { GLANCEABLE_SNAPSHOT_EXPIRY_MS } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { z } from 'zod';

import { deliverGlanceableSnapshot, type GlanceableDeliveryDeps } from './glanceable-delivery';

/**
 * At most one aggregate device wake per account scope per window. A change
 * inside the window leaves a trailing refresh for the DO alarm, so the final
 * counts still land. See #6112: these surfaces must never add device wakeups.
 */
export const GLANCEABLE_DELIVERY_MIN_INTERVAL_MS = 10_000;

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

/** The last device wake for a scope, used to rate-limit aggregate delivery. */
const deliveryStateSchema = z.object({ deliveredAt: z.number() });

/** A refresh deferred until the delivery window elapses. */
const pendingRefreshSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1).nullable(),
  dueAt: z.number(),
});
type PendingGlanceableRefresh = z.infer<typeof pendingRefreshSchema>;

const PENDING_PREFIX = 'glanceable-pending:';

function pendingKey(scope: { userId: string; organizationId: string | null }): string {
  return `${PENDING_PREFIX}${JSON.stringify([scope.userId, scope.organizationId])}`;
}

/** The user DO owns these records; no ordering or interval state lives in a Worker instance. */
export async function refreshGlanceableSnapshot(
  params: { userId: string; organizationId: string | null },
  storage: DurableObjectStorage,
  deps: GlanceableDeliveryDeps,
  nowMs: () => number = Date.now,
  options: { trailing?: boolean } = {}
): Promise<void> {
  const scope = scopeSchema.parse(params);
  const key = `glanceable:${JSON.stringify([scope.userId, scope.organizationId])}`;
  const deliveryKey = `${key}:delivery`;
  // Rate-limit the device wake per scope. A change inside the window is
  // deferred to the alarm rather than dropping it, so the final counts land.
  const delivery = deliveryStateSchema.optional().parse(await storage.get(deliveryKey));
  if (
    delivery !== undefined &&
    nowMs() - delivery.deliveredAt < GLANCEABLE_DELIVERY_MIN_INTERVAL_MS
  ) {
    const dueAt = delivery.deliveredAt + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    await storage.put<PendingGlanceableRefresh>(pendingKey(scope), {
      userId: scope.userId,
      organizationId: scope.organizationId,
      dueAt,
    });
    const currentAlarm = await storage.getAlarm();
    // Only keep an alarm that will actually fire and reschedule before `dueAt`.
    // A past alarm is not a usable schedule — it may be a stale record left by a
    // restart — so a deferral must (re)arm at `dueAt` or the trailing delivery
    // that lands the final counts is never delivered.
    if (currentAlarm === null || currentAlarm <= nowMs() || dueAt < currentAlarm) {
      await storage.setAlarm(dueAt);
    }
    return;
  }
  // Row renewal or temporary absence cannot prove that the native token is live.
  const iosEndPrefix = (token: string) => `glanceable-ios-end:${JSON.stringify(token)}:`;
  // A card raised by push-to-start carries no update token until the app runs
  // and adopts it, so nothing here can update or end it. Without this fence
  // every later refresh raises another card and the Lock Screen stacks them.
  const iosStartPrefix = 'glanceable-ios-start:';
  const iosStartKey = (token: string) => `${iosStartPrefix}${JSON.stringify(token)}`;
  const request = await storage.transaction(async tx => {
    const previous = refreshStateSchema.optional().parse(await tx.get(key));
    const now = nowMs();
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

  // Content-free success evidence for the one-build-per-window invariant
  // (§4.15 rules: identifiers and aggregate counts, never session content).
  // Without this line a passing delivery window leaves no trace in the
  // notifications log and the per-scope window cannot be audited.
  console.log({
    event: 'glanceable_snapshot_build',
    scope: [scope.userId, scope.organizationId],
    revision: request.revision,
    trailing: options.trailing === true,
    status: committed.status,
    running: committed.running,
    needsInput: committed.needsInput,
    idle: committed.idle,
    needsApproval: committed.needsApproval ?? 0,
  });

  const eligible = committed.running + committed.needsInput + committed.idle > 0;
  try {
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
  } catch (error) {
    // A failed attempt still spent the window: the send reached for every
    // device (or the transport is down for all of them), and without a
    // recorded window every later change inside GLANCEABLE_DELIVERY_MIN_INTERVAL_MS
    // retries the whole build+send at once — a failing transport turns each
    // session flip into another burst of builds and device wakes. One attempt
    // per window per scope, and the trailing refresh still carries the final
    // counts at the window end. Re-check the revision first so a superseded
    // attempt opens no window (same rule as the delivered path below), and
    // keep any pending trailing refresh so the deferred change still lands.
    // The error propagates: the entrypoints' existing failure logs stay the
    // per-attempt evidence.
    const current = refreshStateSchema.optional().parse(await storage.get(key));
    if (current?.revision === request.revision) {
      await storage.put(deliveryKey, { deliveredAt: nowMs() });
    }
    throw error;
  }

  // A superseded delivery sent nothing: a newer revision already owns the
  // surface, so opening a window or cancelling its trailing refresh here would
  // drop the change that superseded this one. Re-check the revision first.
  const current = refreshStateSchema.optional().parse(await storage.get(key));
  if (current?.revision !== request.revision) return;

  // A delivered snapshot starts the next window and cancels any trailing refresh.
  await storage.put(deliveryKey, { deliveredAt: nowMs() });
  await storage.delete(pendingKey(scope));
  // One delivery event per window per scope; the trailing flush's line carries
  // the final counts so a deferred burst settles on them.
  console.log({
    event: 'glanceable_delivery',
    scope: [scope.userId, scope.organizationId],
    revision: request.revision,
    trailing: options.trailing === true,
    status: committed.status,
    running: committed.running,
    needsInput: committed.needsInput,
    idle: committed.idle,
    needsApproval: committed.needsApproval ?? 0,
  });
}

/**
 * Deliver every deferred refresh whose window has elapsed, then report the
 * earliest deadline still pending so the caller can reschedule its alarm.
 *
 * A scope that throws must not abort the sweep or the DO's idem GC, so each
 * refresh is isolated. The pending record is consumed before the refresh runs:
 * a failed build keeps its last state and is retried by the next change, and a
 * record written while the sweep runs is caught by the second list.
 */
export async function flushDueGlanceableRefreshes(
  storage: DurableObjectStorage,
  deps: GlanceableDeliveryDeps,
  nowMs: () => number = Date.now
): Promise<number | null> {
  const pending = await storage.list<PendingGlanceableRefresh>({ prefix: PENDING_PREFIX });
  for (const [key, record] of pending) {
    if (record.dueAt > nowMs()) continue;
    await storage.delete(key);
    try {
      await refreshGlanceableSnapshot(
        { userId: record.userId, organizationId: record.organizationId },
        storage,
        deps,
        nowMs,
        { trailing: true }
      );
    } catch (error) {
      console.warn('Glanceable trailing refresh failed', {
        scope: [record.userId, record.organizationId],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Re-list so a record written during the sweep is not stranded.
  const remaining = await storage.list<PendingGlanceableRefresh>({ prefix: PENDING_PREFIX });
  let earliest: number | null = null;
  for (const [, record] of remaining) {
    if (earliest === null || record.dueAt < earliest) earliest = record.dueAt;
  }
  return earliest;
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
