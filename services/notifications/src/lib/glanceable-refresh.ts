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

/**
 * The last device wake for a scope, used to rate-limit aggregate delivery. A
 * failed attempt writes the same record with `outcome: 'failed'` — it still
 * spends the window, but it delivered no snapshot, so a trailing refresh must
 * not read it as a landed delivery that supersedes its deferred change.
 * Optional for records written before this field existed: those only ever came
 * from a successful delivery.
 */
const deliveryStateSchema = z.object({
  deliveredAt: z.number(),
  outcome: z.enum(['delivered', 'failed']).optional(),
});

/** A refresh deferred until the delivery window elapses. */
const pendingRefreshSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1).nullable(),
  dueAt: z.number(),
  // When the deferral was written. A delivery can tell a record it superseded
  // from one that landed while it was in flight only by write time: both carry
  // the same `dueAt` when they defer inside the same window. Optional for
  // records written before this field existed.
  deferredAt: z.number().optional(),
});
type PendingGlanceableRefresh = z.infer<typeof pendingRefreshSchema>;
type DeliveryState = z.infer<typeof deliveryStateSchema>;

const PENDING_PREFIX = 'glanceable-pending:';

function pendingKey(scope: { userId: string; organizationId: string | null }): string {
  return `${PENDING_PREFIX}${JSON.stringify([scope.userId, scope.organizationId])}`;
}

/**
 * Whether a pending record read after a delivery is the same one that was
 * already stored when the delivery started. A deferral written while the
 * delivery was in flight carries a later `deferredAt`, so the delivery must not
 * cancel it: its counts are not in the delivered snapshot.
 */
function isSameDeferral(
  before: PendingGlanceableRefresh | undefined,
  after: PendingGlanceableRefresh | undefined
): boolean {
  if (before === undefined || after === undefined) return before === after;
  return before.dueAt === after.dueAt && before.deferredAt === after.deferredAt;
}

/**
 * Re-arm the deferred change a trailing refresh owes when nothing else carried
 * it, so the flush's consumed pending record is replaced instead of dropped.
 *
 * `buildSnapshot` is awaited after the revision bump, so a concurrent refresh
 * for this scope can deliver while the fetch is in flight. That delivery
 * already covers the change; re-arming would leave a record the alarm later
 * fires a redundant build+send for. Two things keep that from happening:
 *
 * - The delivery record is read and the re-arm is written in one transaction,
 *   the same slot the superseding delivery writes. If the delivery commits
 *   first this read sees it and skips; if the re-arm commits first the
 *   delivery's own landing transaction sees the re-arm and removes it. A plain
 *   read-then-write pair would let the delivery land in between and leave a
 *   record behind.
 * - The re-arm keeps the deferral's original write time in `deferredAt`. The
 *   landing transaction cancels a pending record whose change predates the
 *   delivery's revision, so a re-arm written while the delivery was in flight
 *   is still recognised as superseded. Without the preserved time its own
 *   `deferredAt` would look newer than the snapshot and survive.
 *
 * Skip the re-arm when a delivery actually landed, told by the outcome in the
 * record it wrote: the failure branch writes the same record with
 * `outcome: 'failed'` after spending the window, and treating that as a landed
 * delivery would drop the deferred change with no pending record and no alarm
 * left to retry it. A record without an outcome predates the field and only
 * ever meant a delivery. A pending record already in the slot is a newer
 * deferral this flush did not consume; leave its deadline alone.
 */
async function rearmTrailingRefresh(
  scope: { userId: string; organizationId: string | null },
  storage: DurableObjectStorage,
  deliveryKey: string,
  deliveryAtStart: DeliveryState | undefined,
  deferredChangeAt: number | undefined,
  nowMs: () => number
): Promise<void> {
  const pendingK = pendingKey(scope);
  const now = nowMs();
  await storage.transaction(async tx => {
    const landed = deliveryStateSchema.optional().parse(await tx.get(deliveryKey));
    if (
      landed !== undefined &&
      landed.outcome !== 'failed' &&
      landed.deliveredAt !== deliveryAtStart?.deliveredAt
    ) {
      return;
    }
    if ((await tx.get(pendingK)) !== undefined) return;
    await tx.put<PendingGlanceableRefresh>(pendingK, {
      userId: scope.userId,
      organizationId: scope.organizationId,
      dueAt: now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
      deferredAt: deferredChangeAt ?? now,
    });
  });
}

/** The user DO owns these records; no ordering or interval state lives in a Worker instance. */
export async function refreshGlanceableSnapshot(
  params: { userId: string; organizationId: string | null },
  storage: DurableObjectStorage,
  deps: GlanceableDeliveryDeps,
  nowMs: () => number = Date.now,
  options: { trailing?: boolean; approvalChanged?: boolean; deferredAt?: number } = {}
): Promise<void> {
  const scope = scopeSchema.parse(params);
  const key = `glanceable:${JSON.stringify([scope.userId, scope.organizationId])}`;
  const deliveryKey = `${key}:delivery`;
  // Rate-limit the device wake per scope. A change inside the window is
  // deferred to the alarm rather than dropping it, so the final counts land.
  // `needsApproval` is exempt: it gates the Approve control, which must appear
  // and clear at once on the locked/background surfaces, exactly as the
  // in-app publisher emits a question <-> permission move without waiting.
  const delivery = deliveryStateSchema.optional().parse(await storage.get(deliveryKey));
  if (
    options.approvalChanged !== true &&
    delivery !== undefined &&
    nowMs() - delivery.deliveredAt < GLANCEABLE_DELIVERY_MIN_INTERVAL_MS
  ) {
    const now = nowMs();
    const dueAt = delivery.deliveredAt + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS;
    await storage.put<PendingGlanceableRefresh>(pendingKey(scope), {
      userId: scope.userId,
      organizationId: scope.organizationId,
      dueAt,
      deferredAt: now,
    });
    const currentAlarm = await storage.getAlarm();
    // Only keep an alarm that will actually fire and reschedule before `dueAt`.
    // A past alarm is not a usable schedule — it may be a stale record left by a
    // restart — so a deferral must (re)arm at `dueAt` or the trailing delivery
    // that lands the final counts is never delivered.
    if (currentAlarm === null || currentAlarm <= now || dueAt < currentAlarm) {
      await storage.setAlarm(dueAt);
    }
    return;
  }
  // The delivery that follows supersedes any deferral already stored: its
  // snapshot is built after that change. A deferral written while it is in
  // flight is not superseded, so remember the one that existed at the start and
  // keep a newer one when the delivery completes.
  const pendingBeforeDelivery = pendingRefreshSchema
    .optional()
    .parse(await storage.get(pendingKey(scope)));
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
  if (snapshot === null || (snapshot.status !== 'happy' && snapshot.status !== 'empty')) {
    // A trailing refresh owes the deferred change its final counts. Production
    // `buildSnapshot` returns null (it never throws) when the route or its
    // credentials fail, and the flush has already consumed the pending record,
    // so re-arm the next window instead of dropping the change with no alarm.
    if (options.trailing === true) {
      await rearmTrailingRefresh(scope, storage, deliveryKey, delivery, options.deferredAt, nowMs);
    }
    return;
  }
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
  if (committed === null) {
    // A concurrent refresh bumped the revision while this build was in flight,
    // so the newer revision owns the surface and this attempt must not deliver.
    // It can still have delivered nothing — its own build returns no snapshot
    // when the route fails, and a failed attempt only records a spent window —
    // while the sweep has already consumed the pending record. Re-arm the
    // deferred change unless a delivery actually landed, exactly as the
    // no-snapshot branch above does.
    if (options.trailing === true) {
      await rearmTrailingRefresh(scope, storage, deliveryKey, delivery, options.deferredAt, nowMs);
    }
    return;
  }

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
      await storage.put(deliveryKey, { deliveredAt: nowMs(), outcome: 'failed' });
    }
    throw error;
  }

  // A superseded delivery sent nothing: a newer revision already owns the
  // surface, so opening a window or cancelling its trailing refresh here would
  // drop the change that superseded this one. Re-check the revision first.
  const current = refreshStateSchema.optional().parse(await storage.get(key));
  if (current?.revision !== request.revision) return;

  // A delivered snapshot starts the next window and cancels the trailing
  // refresh it superseded. The record write and the cancel are one transaction
  // so the re-arm in `rearmTrailingRefresh` cannot interleave: whichever
  // commits second sees the other and either skips or removes the record, so a
  // re-arm can never survive as a redundant device wake.
  const deliveredAt = nowMs();
  const deliveredRevisionAt = Date.parse(request.updatedAt);
  await storage.transaction(async tx => {
    await tx.put(deliveryKey, { deliveredAt, outcome: 'delivered' });
    const pendingAfterDelivery = pendingRefreshSchema
      .optional()
      .parse(await tx.get(pendingKey(scope)));
    if (pendingAfterDelivery === undefined) return;
    // A deferral whose change predates this delivery's revision is in the
    // snapshot, whether it was the one this delivery superseded or a re-arm
    // written while the delivery was in flight (a re-arm carries the original
    // deferral's write time). A deferral written after the revision (an
    // approval-exempt delivery can run inside an open window) is not in the
    // snapshot, so keep it: its counts must still land on the trailing alarm.
    const supersededByRevision =
      pendingAfterDelivery.deferredAt !== undefined &&
      pendingAfterDelivery.deferredAt <= deliveredRevisionAt;
    if (isSameDeferral(pendingBeforeDelivery, pendingAfterDelivery) || supersededByRevision) {
      await tx.delete(pendingKey(scope));
    }
  });
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
 * refresh is isolated. The pending record is consumed before the refresh runs,
 * so a refresh that throws (a rejected build or a rejected transport) re-arms
 * the record here: a build that returns no snapshot re-arms itself, and a
 * record written while the sweep runs is caught by the second list. Either way
 * the deferred change keeps a deadline instead of being dropped.
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
        { trailing: true, deferredAt: record.deferredAt }
      );
    } catch (error) {
      console.warn('Glanceable trailing refresh failed', {
        scope: [record.userId, record.organizationId],
        error: error instanceof Error ? error.message : String(error),
      });
      // The refresh threw before it could deliver or re-arm itself: the build
      // rejected (a network/DNS failure on the snapshot route) or the transport
      // rejected. The pending record was consumed above, so re-arm the next
      // window or the deferred counts are dropped with no alarm left to retry
      // them. A record written while the refresh ran already owns the key and a
      // later deadline; only an empty slot is re-armed. The next window, not
      // now, so a persistently failing route is retried once per window instead
      // of spinning the alarm. Keep the consumed record's write time: a delivery
      // that lands later covers that change and cancels this record, while a
      // fresh `now` would look newer than the delivery's snapshot and survive as
      // a redundant wake.
      if ((await storage.get(key)) === undefined) {
        const now = nowMs();
        await storage.put<PendingGlanceableRefresh>(key, {
          userId: record.userId,
          organizationId: record.organizationId,
          dueAt: now + GLANCEABLE_DELIVERY_MIN_INTERVAL_MS,
          deferredAt: record.deferredAt ?? now,
        });
      }
    }
  }

  // Re-list so a record written during the sweep is not stranded.
  return earliestPendingGlanceableRefresh(storage);
}

/**
 * `flushDueGlanceableRefreshes` with its own failures contained. The
 * NotificationChannelDO alarm runs the flush before its idem/rate-limit GC, and
 * that GC is storage reclamation that must not be skipped by a transient
 * glanceable failure (a rejected `list`, a bug in the sweep). The alarm re-reads
 * the pending deadlines after the GC, so a swallowed failure still reschedules
 * the trailing delivery instead of stranding it.
 */
export async function flushDueGlanceableRefreshesSafely(
  storage: DurableObjectStorage,
  deps: GlanceableDeliveryDeps,
  nowMs: () => number = Date.now
): Promise<number | null> {
  try {
    return await flushDueGlanceableRefreshes(storage, deps, nowMs);
  } catch (error) {
    console.warn('Glanceable trailing refresh sweep failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Earliest `dueAt` among the pending refreshes still stored, or null when none
 * remains. The alarm sweep re-reads this after its awaits so a deferral that
 * landed mid-sweep is not overwritten by the alarm it schedules.
 */
export async function earliestPendingGlanceableRefresh(
  storage: DurableObjectStorage
): Promise<number | null> {
  const remaining = await storage.list<PendingGlanceableRefresh>({ prefix: PENDING_PREFIX });
  let earliest: number | null = null;
  for (const [, record] of remaining) {
    if (earliest === null || record.dueAt < earliest) earliest = record.dueAt;
  }
  return earliest;
}

/**
 * Fold the earliest pending glanceable deadline into the alarm the sweep chose.
 * The sweep awaits between choosing `candidate` and setting it, so a deferral
 * that landed in between must not be overwritten by the later `candidate`.
 */
export async function foldPendingGlanceableRefreshDeadline(
  storage: DurableObjectStorage,
  candidate: number | undefined
): Promise<number | undefined> {
  const pending = await earliestPendingGlanceableRefresh(storage);
  if (pending === null) return candidate;
  return candidate === undefined || pending < candidate ? pending : candidate;
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
