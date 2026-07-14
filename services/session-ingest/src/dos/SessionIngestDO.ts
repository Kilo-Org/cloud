import { DurableObject } from 'cloudflare:workers';
import { eq, ne, gt, gte, lt, and, or, inArray, isNull, isNotNull } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import { ingestItems, ingestMeta } from '../db/sqlite-schema';
import type { Env } from '../env';
import type { IngestBatch } from '../types/session-sync';
import type { SessionDataItem } from '../types/session-sync';
import { getItemIdentity, getPartItemIdentityRange } from '../util/compaction';
import {
  extractNormalizedGitBranchFromItem,
  extractNormalizedGitUrlFromItem,
  extractNormalizedOrgIdFromItem,
  extractNormalizedParentIdFromItem,
  extractNormalizedPlatformFromItem,
  extractNormalizedTitleFromItem,
  extractStatusFromItem,
} from './session-ingest-extractors';
import {
  computeSessionMetrics,
  INACTIVITY_TIMEOUT_MS,
  POST_CLOSE_DRAIN_MS,
  type TerminationReason,
} from './session-metrics';
import migrations from '../../drizzle/migrations';
import {
  claimNextDispatchable,
  getOutboxRow,
  markDispatched,
  markMissingSession,
  markRetry,
  markSuppressedByPresence,
  parkExpiredPendingRows,
  recordRaiseIntent,
  recordResolveIntent,
  recoverStaleInFlightRows,
} from '../attention-outbox-store';
import { recordAttentionEventInputSchema } from './attention-event-input';
import { computeNextAlarmTime, shouldEmitMetricsFromAttentionAlarm } from './attention-alarm';
import {
  readKiloSdkMessages,
  readKiloSdkSessionSnapshot,
  type KiloSdkSessionSnapshotRead,
} from './kilo-sdk-materialization';

type IngestMetaKey =
  | ExtractableMetaKey
  | 'kiloUserId'
  | 'sessionId'
  | 'ingestVersion'
  | 'closeReason'
  | 'metricsEmitted'
  | 'metricsAlarmAt'
  | 'deleted'
  | 'sessionReadyNotified';

/**
 * Bound the outbox dispatch work per alarm so a hot loop can't run the alarm
 * out of wallclock. The alarm reschedules itself to the earliest remaining
 * `next_attempt_at` when it stops short.
 */
const MAX_DISPATCH_PER_ALARM = 25;

type ExtractableMetaKey =
  | 'title'
  | 'parentId'
  | 'platform'
  | 'orgId'
  | 'gitUrl'
  | 'gitBranch'
  | 'status';

function writeIngestMetaIfChanged(
  db: DrizzleSqliteDODatabase,
  params: { key: IngestMetaKey; incomingValue: string | null }
): { changed: boolean; value: string | null } {
  const existing = db
    .select({ value: ingestMeta.value })
    .from(ingestMeta)
    .where(eq(ingestMeta.key, params.key))
    .get();
  const currentValue = existing?.value ?? null;

  if (currentValue === params.incomingValue) {
    return { changed: false, value: params.incomingValue };
  }

  db.insert(ingestMeta)
    .values({ key: params.key, value: params.incomingValue })
    .onConflictDoUpdate({ target: ingestMeta.key, set: { value: params.incomingValue } })
    .run();

  return { changed: true, value: params.incomingValue };
}

const INGEST_META_EXTRACTORS: Array<{
  key: ExtractableMetaKey;
  extract: (item: IngestBatch[number]) => string | null | undefined;
}> = [
  { key: 'title', extract: extractNormalizedTitleFromItem },
  { key: 'parentId', extract: extractNormalizedParentIdFromItem },
  { key: 'platform', extract: extractNormalizedPlatformFromItem },
  { key: 'orgId', extract: extractNormalizedOrgIdFromItem },
  { key: 'gitUrl', extract: extractNormalizedGitUrlFromItem },
  { key: 'gitBranch', extract: extractNormalizedGitBranchFromItem },
  { key: 'status', extract: extractStatusFromItem },
];

type Changes = Array<{ name: ExtractableMetaKey; value: string | null }>;

export type IngestResult =
  | { accepted: true; changes: Changes }
  | { accepted: false; reason: 'deleted'; changes: never[] };

type IngestLifecycleEvent =
  | { type: 'session_open' }
  | {
      type: 'session_close';
      reason: Extract<SessionDataItem, { type: 'session_close' }>['data']['reason'];
    };

export type IngestOrderCursor = { ingestedAt: number | null; id: number };

export function afterIngestOrderCursor(cursor: IngestOrderCursor) {
  if (cursor.ingestedAt === null) {
    return or(
      and(isNull(ingestItems.ingested_at), gt(ingestItems.id, cursor.id)),
      isNotNull(ingestItems.ingested_at)
    );
  }

  return or(
    gt(ingestItems.ingested_at, cursor.ingestedAt),
    and(eq(ingestItems.ingested_at, cursor.ingestedAt), gt(ingestItems.id, cursor.id))
  );
}

export function ingestOrderCursor(row: {
  ingested_at: number | null;
  id: number;
}): IngestOrderCursor {
  return { ingestedAt: row.ingested_at, id: row.id };
}

export class SessionIngestDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.db = drizzle(state.storage, { logger: false });

    void state.blockConcurrencyWhile(() => {
      return migrate(this.db, migrations);
    });
  }

  async ingest(
    payload: IngestBatch,
    kiloUserId: string,
    sessionId: string,
    ingestVersion = 0,
    ingestedAt?: number,
    r2References?: Record<string, string>
  ): Promise<IngestResult> {
    const deletedRow = this.db
      .select({ value: ingestMeta.value })
      .from(ingestMeta)
      .where(eq(ingestMeta.key, 'deleted'))
      .get();
    if (deletedRow?.value === 'true') {
      // Clean up any R2 blobs the caller uploaded for this now-deleted session
      if (r2References) {
        const keys = Object.values(r2References);
        if (keys.length > 0) {
          await this.env.SESSION_INGEST_R2.delete(keys);
        }
      }
      return { accepted: false, reason: 'deleted', changes: [] };
    }

    writeIngestMetaIfChanged(this.db, { key: 'kiloUserId', incomingValue: kiloUserId });
    writeIngestMetaIfChanged(this.db, { key: 'sessionId', incomingValue: sessionId });
    writeIngestMetaIfChanged(this.db, {
      key: 'ingestVersion',
      incomingValue: String(ingestVersion),
    });

    const incomingByKey: Record<ExtractableMetaKey, string | null | undefined> = {
      title: undefined,
      parentId: undefined,
      platform: undefined,
      orgId: undefined,
      gitUrl: undefined,
      gitBranch: undefined,
      status: undefined,
    };

    const lifecycleEvents: IngestLifecycleEvent[] = [];
    const orphanedR2Keys: string[] = [];

    for (const item of payload) {
      const { item_id, item_type } = getItemIdentity(item);

      // Check timestamp guard: skip if existing row has a newer ingested_at.
      // Also read the existing R2 key so we can clean up orphaned blobs.
      if (ingestedAt !== undefined) {
        const existing = this.db
          .select({
            ingested_at: ingestItems.ingested_at,
            item_data_r2_key: ingestItems.item_data_r2_key,
          })
          .from(ingestItems)
          .where(eq(ingestItems.item_id, item_id))
          .get();
        if (
          existing?.ingested_at !== null &&
          existing?.ingested_at !== undefined &&
          existing.ingested_at > ingestedAt
        ) {
          // Item is stale — if the caller wrote an R2 blob for it, that blob is orphaned
          const newR2Key = r2References?.[item_id];
          if (newR2Key) orphanedR2Keys.push(newR2Key);
          continue;
        }

        // If the existing row pointed to a different R2 blob, it will be orphaned after upsert
        const newR2Key = r2References?.[item_id] ?? null;
        if (existing?.item_data_r2_key && existing.item_data_r2_key !== newR2Key) {
          orphanedR2Keys.push(existing.item_data_r2_key);
        }
      }

      const r2Key = r2References?.[item_id];
      const itemDataJson = r2Key ? '{}' : JSON.stringify(item.data);
      const itemDataR2Key = r2Key ?? null;

      this.db
        .insert(ingestItems)
        .values({
          item_id,
          item_type,
          item_data: itemDataJson,
          item_data_r2_key: itemDataR2Key,
          ingested_at: ingestedAt ?? null,
        })
        .onConflictDoUpdate({
          target: ingestItems.item_id,
          set: {
            item_type,
            item_data: itemDataJson,
            item_data_r2_key: itemDataR2Key,
            ingested_at: ingestedAt ?? null,
          },
        })
        .run();

      for (const extractor of INGEST_META_EXTRACTORS) {
        const maybeValue = extractor.extract(item);
        if (maybeValue !== undefined) {
          incomingByKey[extractor.key] = maybeValue;
        }
      }

      if (ingestVersion >= 1) {
        if (item.type === 'session_open') {
          lifecycleEvents.push({ type: 'session_open' });
        } else if (item.type === 'session_close') {
          lifecycleEvents.push({ type: 'session_close', reason: item.data.reason });
        }
      }
    }

    if (ingestVersion >= 1) {
      // v1 clients send explicit open/close pairs. Only those events drive alarms.
      for (const event of lifecycleEvents) {
        if (event.type === 'session_open') {
          // New turn starting — clear prior emission so metrics are re-computed.
          this.db
            .delete(ingestMeta)
            .where(inArray(ingestMeta.key, ['metricsEmitted', 'closeReason']))
            .run();
          await this.setSharedAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
        } else {
          writeIngestMetaIfChanged(this.db, {
            key: 'closeReason',
            incomingValue: event.reason,
          });
          await this.setSharedAlarm(Date.now() + POST_CLOSE_DRAIN_MS);
        }
      }
      // Events without open/close (stragglers) don't touch the alarm.
    } else {
      // v0 (legacy): no open/close signals, rely on inactivity timeout.
      await this.setSharedAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
    }

    const changes: Changes = [];
    for (const key of Object.keys(incomingByKey) as ExtractableMetaKey[]) {
      const incoming = incomingByKey[key];
      if (incoming === undefined) continue;
      const meta = writeIngestMetaIfChanged(this.db, {
        key,
        incomingValue: incoming,
      });
      if (meta.changed) {
        changes.push({ name: key, value: meta.value });
      }
    }

    // Clean up orphaned R2 blobs after metadata is persisted. R2 is external I/O,
    // so awaiting it before metadata writes can let another DO request interleave
    // and then be overwritten by stale pre-await metadata from this request.
    if (orphanedR2Keys.length > 0) {
      this.ctx.waitUntil(
        this.env.SESSION_INGEST_R2.delete(orphanedR2Keys).catch(error => {
          console.error('Failed to delete orphaned session-ingest R2 blobs', {
            kiloUserId,
            sessionId,
            count: orphanedR2Keys.length,
            error: error instanceof Error ? error.message : String(error),
          });
        })
      );
    }

    return {
      accepted: true,
      changes,
    };
  }

  /**
   * Push "session ready to control from your phone" the first time it is
   * claimed for this session. The caller (UserConnectionDO) invokes this when
   * a CLI heartbeat first reports the session as remote-controllable; the
   * `sessionReadyNotified` meta row here makes the push once-ever durable —
   * CLI reconnects and UserConnectionDO evictions can't re-arm it. Push
   * failures are non-fatal: log and move on.
   */
  claimSessionReadyPush(kiloUserId: string, sessionId: string): void {
    const deletedRow = this.db
      .select({ value: ingestMeta.value })
      .from(ingestMeta)
      .where(eq(ingestMeta.key, 'deleted'))
      .get();
    if (deletedRow?.value === 'true') return;

    const notified = writeIngestMetaIfChanged(this.db, {
      key: 'sessionReadyNotified',
      incomingValue: 'true',
    });
    if (!notified.changed) return;

    this.ctx.waitUntil(
      this.env.NOTIFICATIONS.sendSessionReadyNotification({
        userId: kiloUserId,
        cliSessionId: sessionId,
      }).catch((error: unknown) => {
        console.error('Failed to send session-ready push (non-fatal)', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
    );
  }

  /**
   * Direct DO RPC: record a human-attention event for this session.
   *
   * Accepts only IDs and a classified raise/resolve intent — the DO never
   * sees prompt text, permission arguments, or any other envelope payload.
   * Raise intents are recorded into the per-session outbox; resolve intents
   * cancel or stamp a terminal row. The alarm is rescheduled so the outbox
   * dispatches on the next tick.
   *
   * Idempotency: a re-raise of the same request id is a no-op; resolving a
   * request that was never raised is a no-op; re-raising a resolved row is
   * a no-op (the user already saw the outcome). The dispatch path is the
   * sole owner of network IO, so the RPC itself never calls the
   * notifications service — failures there are contained to the alarm.
   */
  async recordAttentionEvent(
    rawParams: unknown
  ): Promise<{ accepted: true } | { accepted: false; reason: 'invalid_input' | 'deleted' }> {
    const parsed = recordAttentionEventInputSchema.safeParse(rawParams);
    if (!parsed.success) {
      return { accepted: false, reason: 'invalid_input' };
    }
    const params = parsed.data;

    const deletedRow = this.db
      .select({ value: ingestMeta.value })
      .from(ingestMeta)
      .where(eq(ingestMeta.key, 'deleted'))
      .get();
    if (deletedRow?.value === 'true') {
      return { accepted: false, reason: 'deleted' };
    }

    writeIngestMetaIfChanged(this.db, { key: 'kiloUserId', incomingValue: params.kiloUserId });
    writeIngestMetaIfChanged(this.db, { key: 'sessionId', incomingValue: params.sessionId });

    const now = Date.now();
    if (params.intent.kind === 'raise') {
      recordRaiseIntent(this.db, {
        requestId: params.requestId,
        reason: params.intent.reason,
        now,
      });
    } else {
      recordResolveIntent(this.db, {
        requestId: params.requestId,
        reason: params.intent.reason,
        now,
      });
    }

    // Always reschedule: a raise wants to fire immediately; a resolve may
    // free the alarm entirely (no remaining work) or shift the next attempt
    // to an earlier pending row. `rescheduleAlarm` picks the correct
    // outcome.
    await this.rescheduleAlarm();

    return { accepted: true };
  }

  async readKiloSdkSessionSnapshot(): Promise<KiloSdkSessionSnapshotRead> {
    return readKiloSdkSessionSnapshot(this.db, this.env.SESSION_INGEST_R2);
  }

  async readKiloSdkMessages(params: { limit?: number; before?: string }) {
    return readKiloSdkMessages(this.db, this.env.SESSION_INGEST_R2, params);
  }

  async getAllStream(): Promise<ReadableStream<Uint8Array>> {
    const db = this.db;
    const r2 = this.env.SESSION_INGEST_R2;
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          // --- session info ---
          controller.enqueue(encoder.encode('{"info":'));
          const sessionRow = db
            .select({
              item_data: ingestItems.item_data,
              item_data_r2_key: ingestItems.item_data_r2_key,
            })
            .from(ingestItems)
            .where(eq(ingestItems.item_type, 'session'))
            .limit(1)
            .get();
          if (sessionRow) {
            await enqueueItemData(controller, sessionRow, r2, encoder);
          } else {
            controller.enqueue(encoder.encode('{}'));
          }

          // --- messages ---
          const CURSOR_BATCH = 10;
          controller.enqueue(encoder.encode(',"messages":['));
          let msgCursor: IngestOrderCursor | undefined;
          let firstMsg = true;

          while (true) {
            const msgBatch = db
              .select({
                id: ingestItems.id,
                ingested_at: ingestItems.ingested_at,
                item_id: ingestItems.item_id,
                item_data: ingestItems.item_data,
                item_data_r2_key: ingestItems.item_data_r2_key,
              })
              .from(ingestItems)
              .where(
                and(
                  eq(ingestItems.item_type, 'message'),
                  msgCursor ? afterIngestOrderCursor(msgCursor) : undefined
                )
              )
              .orderBy(ingestItems.ingested_at, ingestItems.id)
              .limit(CURSOR_BATCH)
              .all();

            if (msgBatch.length === 0) break;
            msgCursor = ingestOrderCursor(msgBatch[msgBatch.length - 1]);

            for (const msgRow of msgBatch) {
              if (!firstMsg) controller.enqueue(encoder.encode(','));
              firstMsg = false;

              // message info
              controller.enqueue(encoder.encode('{"info":'));
              await enqueueItemData(controller, msgRow, r2, encoder);

              // parts for this message: item_id = '{msgId}/{partId}'
              const msgId = msgRow.item_id.slice('message/'.length);
              const partRange = getPartItemIdentityRange(msgId);
              controller.enqueue(encoder.encode(',"parts":['));
              let partCursor: IngestOrderCursor | undefined;
              let firstPart = true;

              while (true) {
                const partBatch = db
                  .select({
                    id: ingestItems.id,
                    ingested_at: ingestItems.ingested_at,
                    item_data: ingestItems.item_data,
                    item_data_r2_key: ingestItems.item_data_r2_key,
                  })
                  .from(ingestItems)
                  .where(
                    and(
                      eq(ingestItems.item_type, 'part'),
                      gte(ingestItems.item_id, partRange.start),
                      lt(ingestItems.item_id, partRange.end),
                      partCursor ? afterIngestOrderCursor(partCursor) : undefined
                    )
                  )
                  .orderBy(ingestItems.ingested_at, ingestItems.id)
                  .limit(CURSOR_BATCH)
                  .all();

                if (partBatch.length === 0) break;
                partCursor = ingestOrderCursor(partBatch[partBatch.length - 1]);

                for (const partRow of partBatch) {
                  if (!firstPart) controller.enqueue(encoder.encode(','));
                  firstPart = false;

                  await enqueueItemData(controller, partRow, r2, encoder);
                }
              }

              controller.enqueue(encoder.encode(']}'));
            }
          }

          controller.enqueue(encoder.encode(']'));
          controller.enqueue(encoder.encode(',"sessionDiff":'));
          const diffRow = db
            .select({
              item_data: ingestItems.item_data,
              item_data_r2_key: ingestItems.item_data_r2_key,
            })
            .from(ingestItems)
            .where(eq(ingestItems.item_type, 'session_diff'))
            .limit(1)
            .get();
          if (diffRow) {
            await enqueueItemData(controller, diffRow, r2, encoder, '[]');
          } else {
            controller.enqueue(encoder.encode('[]'));
          }
          controller.enqueue(encoder.encode('}'));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });
  }

  /**
   * Compute and emit session metrics to the o11y worker.
   * Returns true if metrics were emitted, false if already emitted or no data.
   *
   * Emits a fresh alarm afterward via `rescheduleAlarm` so a metrics fire does
   * not cancel any still-pending outbox work. The metrics alarm time is
   * cleared once emission succeeds; the shared alarm scheduler reschedules
   * itself to the earliest remaining outbox attempt (or deletes the alarm
   * only when no work remains).
   */
  private async emitSessionMetrics(
    kiloUserId: string,
    sessionId: string,
    closeReason: TerminationReason,
    ingestVersion: number
  ): Promise<boolean> {
    const emittedRow = this.db
      .select({ value: ingestMeta.value })
      .from(ingestMeta)
      .where(eq(ingestMeta.key, 'metricsEmitted'))
      .get();
    if (emittedRow?.value === 'true') {
      return false;
    }

    // Note: items that exceeded the DO SQLite row limit (~1.94MB) are stored in R2
    // with item_data='{}'. Metrics reads only item_data from SQLite, so those items
    // contribute empty data. This is acceptable — oversized items are rare edge cases
    // (giant tool results) and metrics only needs small fields (timestamps, types).
    const rows = this.db
      .select({
        item_type: ingestItems.item_type,
        item_data: ingestItems.item_data,
      })
      .from(ingestItems)
      .where(ne(ingestItems.item_type, 'session_diff'))
      .orderBy(ingestItems.ingested_at, ingestItems.id)
      .all();

    if (rows.length === 0) {
      return false;
    }

    const metrics = computeSessionMetrics(rows, closeReason);

    const modelRow = this.db
      .select({ item_data: ingestItems.item_data })
      .from(ingestItems)
      .where(eq(ingestItems.item_id, 'model'))
      .get();
    let model: string | undefined;
    if (modelRow) {
      try {
        const arr = JSON.parse(modelRow.item_data) as Extract<
          SessionDataItem,
          { type: 'model' }
        >['data'];
        if (arr.length > 0) {
          model = arr[arr.length - 1].id;
        }
      } catch {
        // Best-effort: skip model on parse errors.
      }
    }

    await this.env.O11Y.ingestSessionMetrics({
      kiloUserId,
      sessionId,
      ingestVersion,
      model,
      ...metrics,
    });

    // Mark metrics as emitted to prevent duplicates and clear the metrics
    // alarm time so the shared scheduler no longer considers it.
    this.db
      .insert(ingestMeta)
      .values({ key: 'metricsEmitted', value: 'true' })
      .onConflictDoUpdate({ target: ingestMeta.key, set: { value: 'true' } })
      .run();
    this.db.delete(ingestMeta).where(eq(ingestMeta.key, 'metricsAlarmAt')).run();

    return true;
  }

  /**
   * Schedule (or reschedule) the single DO alarm to fire at the earliest
   * pending work: the metrics alarm time when metrics have not yet emitted,
   * or the earliest outbox `next_attempt_at`. When both are empty the alarm
   * is deleted entirely.
   */
  private async rescheduleAlarm(): Promise<void> {
    const next = computeNextAlarmTime(this.db);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /**
   * Persist a new metrics alarm time and re-run the shared alarm scheduler.
   * Every place ingest previously called `setAlarm` directly must use this
   * helper so the outbox can still preempt the metrics timer.
   */
  private async setSharedAlarm(when: number): Promise<void> {
    this.db
      .insert(ingestMeta)
      .values({ key: 'metricsAlarmAt', value: String(when) })
      .onConflictDoUpdate({ target: ingestMeta.key, set: { value: String(when) } })
      .run();
    await this.rescheduleAlarm();
  }

  /**
   * Process up to `MAX_DISPATCH_PER_ALARM` outbox rows for the alarm's
   * session. Each row is claimed, dispatched via the notifications binding,
   * and transitioned to a terminal status. Rows that were resolved
   * mid-flight are not overwritten. The caller is responsible for the final
   * reschedule.
   */
  private async dispatchOutboxBatch(params: {
    kiloUserId: string;
    sessionId: string;
  }): Promise<void> {
    for (let i = 0; i < MAX_DISPATCH_PER_ALARM; i++) {
      const claimed = claimNextDispatchable(this.db, { now: Date.now() });
      if (!claimed) return;

      let result: {
        dispatched: boolean;
        reason?: 'missing_session' | 'dispatch_failed' | 'suppressed_presence';
      };
      try {
        result = await this.env.NOTIFICATIONS.sendSessionAttentionNotification({
          userId: params.kiloUserId,
          cliSessionId: params.sessionId,
          requestId: claimed.requestId,
          reason: claimed.reason,
        });
      } catch (_error) {
        // A thrown error is treated like `dispatch_failed`: bounded retry
        // through `markRetry` (terminal `failed` once `MAX_ATTEMPTS` is hit).
        // We never log the request id or reason, and we never store the raw
        // thrown message in the outbox — only fixed safe codes.
        console.error('SessionIngestDO attention dispatch threw', {
          sessionId: params.sessionId,
          kiloUserId: params.kiloUserId,
          attemptCount: claimed.attemptCount,
          code: 'rpc_error',
        });
        // If markRetry throws (unknown row), it is an invariant violation
        // intentionally surfaced to the platform alarm retry; do not wrap
        // or suppress it here.
        markRetry(this.db, {
          requestId: claimed.requestId,
          now: Date.now(),
          reason: 'rpc_error',
        });
        continue;
      }

      // A resolve that landed between the claim and the await must win.
      const fresh = getOutboxRow(this.db, claimed.requestId);
      if (fresh?.status === 'resolved') continue;

      if (result.dispatched) {
        markDispatched(this.db, { requestId: claimed.requestId, now: Date.now() });
        continue;
      }

      switch (result.reason) {
        case 'suppressed_presence':
          markSuppressedByPresence(this.db, { requestId: claimed.requestId, now: Date.now() });
          break;
        case 'missing_session':
          markMissingSession(this.db, { requestId: claimed.requestId, now: Date.now() });
          break;
        case 'dispatch_failed':
        default:
          markRetry(this.db, {
            requestId: claimed.requestId,
            now: Date.now(),
            reason: 'dispatch_failed',
          });
          break;
      }
    }
  }

  /**
   * Alarm fires either after POST_CLOSE_DRAIN_MS (session closed),
   * INACTIVITY_TIMEOUT_MS (no activity), or immediately after a
   * `recordAttentionEvent` raise. The same alarm is shared between the
   * metrics lifecycle and the outbox dispatch loop — every scheduling
   * decision goes through `rescheduleAlarm` so the two cannot clobber
   * each other.
   *
   * The body is intentionally resilient: dispatch errors are caught,
   * logged, and translated into a bounded retry; only `emitSessionMetrics`
   * errors propagate so the platform can retry the alarm itself.
   */
  async alarm(): Promise<void> {
    const metaRows = this.db
      .select()
      .from(ingestMeta)
      .where(
        inArray(ingestMeta.key, [
          'kiloUserId',
          'sessionId',
          'closeReason',
          'ingestVersion',
          'deleted',
          'metricsEmitted',
          'metricsAlarmAt',
        ])
      )
      .all();

    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));

    if (meta['deleted'] === 'true') {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const kiloUserId = meta['kiloUserId'];
    const sessionId = meta['sessionId'];

    if (!kiloUserId || !sessionId) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    // Park any pending rows whose `next_attempt_at` has crossed the
    // absolute dispatch window (raisedAt + ATTENTION_MAX_DISPATCH_AGE_MS).
    // Doing this at alarm start (and again inside `claimNextDispatchable`
    // for defense in depth) keeps `earliestScheduledAttemptAt` from
    // pointing the next alarm at a row that can no longer be safely
    // dispatched under the receiver's 60min idempotency TTL.
    parkExpiredPendingRows(this.db, { now: Date.now() });

    // Recover any rows left in `in_flight` from a previous alarm that was
    // lost (DO restart, crash between claim and ack). Each stale row is
    // bumped back to `pending` with a fresh schedule, or parked at
    // terminal `failed` if the cap is reached. Downstream dispatch is
    // keyed on the stable request id, so a recovered row cannot double
    // push.
    recoverStaleInFlightRows(this.db, { now: Date.now() });

    await this.dispatchOutboxBatch({ kiloUserId, sessionId });

    // Re-read the metrics state AFTER `dispatchOutboxBatch` returns. The
    // batch awaits external IO (the notifications RPC), during which a
    // concurrent ingest can update `metricsAlarmAt` (e.g. a new
    // session_open resetting the inactivity timer) or another alarm path
    // can mark `metricsEmitted`. Emitting metrics on stale state read at
    // the top of `alarm()` would publish prematurely when the immediate
    // outbox alarm preempted a far-future metrics deadline, or would
    // double-publish when emission was already done elsewhere.
    const freshMeta = this.db
      .select({ key: ingestMeta.key, value: ingestMeta.value })
      .from(ingestMeta)
      .where(inArray(ingestMeta.key, ['metricsEmitted', 'metricsAlarmAt']))
      .all();
    const freshMetricsEmitted = freshMeta.find(row => row.key === 'metricsEmitted')?.value ?? null;
    const freshMetricsAlarmAt = freshMeta.find(row => row.key === 'metricsAlarmAt')?.value ?? null;

    const closeReason = (meta['closeReason'] ?? 'abandoned') as TerminationReason;
    const ingestVersion = Number(meta['ingestVersion'] ?? '0') || 0;

    if (shouldEmitMetricsFromAttentionAlarm(freshMetricsEmitted, freshMetricsAlarmAt, Date.now())) {
      // DO alarm exceptions don't populate the Exceptions array in logpush traces,
      // so without this catch we get outcome=exception with zero diagnostics.
      try {
        await this.emitSessionMetrics(kiloUserId, sessionId, closeReason, ingestVersion);
      } catch (error) {
        console.error('SessionIngestDO alarm failed', {
          sessionId,
          kiloUserId,
          closeReason,
          ingestVersion,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        throw error;
      }
    }

    await this.rescheduleAlarm();
  }

  /** Returns true when no ingest data has been stored for this session. */
  isEmpty(): boolean {
    const row = this.db.select({ id: ingestItems.id }).from(ingestItems).limit(1).get();
    return !row;
  }

  /** Atomically check emptiness and clear within a single DO request,
   *  preventing TOCTOU races where data arrives between isEmpty() and clear(). */
  async clearIfEmpty(): Promise<boolean> {
    if (!this.isEmpty()) return false;
    await this.clear();
    return true;
  }

  async clear(): Promise<void> {
    // Delete any R2-backed item blobs before wiping SQLite
    const r2Rows = this.db
      .select({ item_data_r2_key: ingestItems.item_data_r2_key })
      .from(ingestItems)
      .where(isNotNull(ingestItems.item_data_r2_key))
      .all();
    const r2Keys = r2Rows.map(r => r.item_data_r2_key).filter((k): k is string => k !== null);
    if (r2Keys.length > 0) {
      await this.env.SESSION_INGEST_R2.delete(r2Keys);
    }

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await migrate(this.db, migrations);
    this.db
      .insert(ingestMeta)
      .values({ key: 'deleted', value: 'true' })
      .onConflictDoUpdate({ target: ingestMeta.key, set: { value: 'true' } })
      .run();
  }
}

type ItemDataRef = Pick<typeof ingestItems.$inferSelect, 'item_data' | 'item_data_r2_key'>;

async function enqueueItemData(
  controller: ReadableStreamDefaultController<Uint8Array>,
  ref: ItemDataRef,
  r2: R2Bucket,
  encoder: TextEncoder,
  missingFallback = '{}'
): Promise<void> {
  if (ref.item_data_r2_key) {
    const obj = await r2.get(ref.item_data_r2_key);
    if (obj) {
      const reader = obj.body.getReader();
      while (true) {
        const result: ReadableStreamReadResult<Uint8Array> = await reader.read();
        if (result.done) break;
        controller.enqueue(result.value);
      }
    } else {
      console.error('R2 blob missing during export, using fallback item data', {
        r2Key: ref.item_data_r2_key,
      });
      controller.enqueue(encoder.encode(missingFallback));
    }
  } else {
    controller.enqueue(encoder.encode(ref.item_data));
  }
}

export function getSessionIngestDO(env: Env, params: { kiloUserId: string; sessionId: string }) {
  const doKey = `${params.kiloUserId}/${params.sessionId}`;
  const id = env.SESSION_INGEST_DO.idFromName(doKey);
  return env.SESSION_INGEST_DO.get(id);
}
