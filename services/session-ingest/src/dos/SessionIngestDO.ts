import { DurableObject } from 'cloudflare:workers';
import { desc, eq, ne, gt, gte, lt, and, or, inArray, isNull, isNotNull } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { ingestItems, ingestMeta, agentNotificationDispatch } from '../db/sqlite-schema';
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
  buildAssistantExcerpt,
  completedAssistantMessageIdFromItemData,
  isCompletedStatus,
  isNeedsInputStatus,
  type AttentionSignal,
} from './session-ingest-attention';
import {
  computeSessionMetrics,
  INACTIVITY_TIMEOUT_MS,
  POST_CLOSE_DRAIN_MS,
  type TerminationReason,
} from './session-metrics';
import migrations from '../../drizzle/migrations';
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
  | 'deleted'
  | 'sessionReadyNotified';

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

function hasIngestMeta(db: DrizzleSqliteDODatabase, key: IngestMetaKey): boolean {
  return (
    db.select({ value: ingestMeta.value }).from(ingestMeta).where(eq(ingestMeta.key, key)).get() !==
    undefined
  );
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
  | { accepted: true; changes: Changes; attentionSignals: AttentionSignal[] }
  | { accepted: false; reason: 'deleted'; changes: never[] };
/** How many of the newest message rows to inspect when pairing an idle transition with the assistant turn that just finished. */
const COMPLETED_MESSAGE_SCAN_LIMIT = 50;

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
    // §4.10: in-batch {notificationId -> message} so the post-loop signal builder can
    // re-emit on replay without re-reading item_data from SQLite.
    const pendingAgentNotifications = new Map<string, string>();

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

      // §4.10: agent_notification items carry no state transition, so the DO durably tracks
      // per-identity dispatch state alongside the item. Insert-if-absent keeps replays from
      // re-arming an already-pending identity; the row is only flipped to `dispatched` after
      // the caller reports a terminal local decision. The ingest response will emit the
      // signal below whenever this row's state is `pending`.
      if (item.type === 'agent_notification') {
        const identity = `agent_notification/${item.data.id}`;
        const inserted = this.db
          .insert(agentNotificationDispatch)
          .values({ identity, state: 'pending', created_at: Date.now() })
          .onConflictDoNothing({ target: agentNotificationDispatch.identity })
          .returning({ state: agentNotificationDispatch.state })
          .get();
        // Insert-if-absent: only a fresh row (returning populated) is `pending` for this batch.
        // A replay where the row was already `dispatched` must not re-emit the signal.
        if (inserted) {
          pendingAgentNotifications.set(item.data.id, item.data.message);
        } else {
          const existing = this.db
            .select({ state: agentNotificationDispatch.state })
            .from(agentNotificationDispatch)
            .where(eq(agentNotificationDispatch.identity, identity))
            .get();
          if (existing?.state === 'pending') {
            pendingAgentNotifications.set(item.data.id, item.data.message);
          }
        }
      }

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
          await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
        } else {
          writeIngestMetaIfChanged(this.db, {
            key: 'closeReason',
            incomingValue: event.reason,
          });
          await this.ctx.storage.setAlarm(Date.now() + POST_CLOSE_DRAIN_MS);
        }
      }
      // Events without open/close (stragglers) don't touch the alarm.
    } else {
      // v0 (legacy): no open/close signals, rely on inactivity timeout.
      await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
    }

    // Read before the write loop below persists incoming values: whether this session had ever
    // reported a status. The first-ever status write also registers as a change, and a
    // full-history backfill of an already-idle session must not push about an old turn.
    const hadPriorStatus = hasIngestMeta(this.db, 'status');

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

    const attentionSignals: AttentionSignal[] = [];

    const statusChange = changes.find(change => change.name === 'status');
    if (statusChange && isCompletedStatus(statusChange.value) && hadPriorStatus) {
      // An idle transition means the assistant finished its turn. Pair it with the most recent
      // completed assistant message so the signal carries that turn's excerpt; if none exists yet
      // (e.g. a fresh session reporting idle before any turn), emit nothing rather than a spurious
      // "Task completed" push.
      const completedMessageId = this.findLastCompletedAssistantMessageId();
      if (completedMessageId) {
        attentionSignals.push({
          signalId: completedMessageId,
          kind: 'completed',
          messageExcerpt: this.buildAssistantExcerptForMessage(completedMessageId),
        });
      }
    } else if (statusChange && isNeedsInputStatus(statusChange.value)) {
      attentionSignals.push({
        signalId: `status:${statusChange.value}:${ingestedAt ?? Date.now()}`,
        kind: 'needs_input',
        messageExcerpt: '',
      });
    }

    // §4.10: include the agent_notification signal in the ingest response WHENEVER the
    // identity's state is `pending` — fresh insert or replay alike. The caller flips the
    // state to `dispatched` after a terminal local decision; only a thrown RPC/transport
    // error leaves the marker `pending` so a subsequent replay can re-emit.
    for (const [notificationId, message] of pendingAgentNotifications) {
      attentionSignals.push({ kind: 'agent_notification', notificationId, message });
    }

    return {
      accepted: true,
      changes,
      attentionSignals,
    };
  }

  /**
   * Flip a pending `agent_notification` dispatch identity to `dispatched`. Idempotent.
   * Called by the dispatching caller (queue-consumer / direct-ingest) at the post-commit
   * dispatch boundary once the attempt reaches a terminal local decision. A thrown
   * upstream RPC/transport error must NOT reach this call — leaving the row `pending`
   * is what allows a future replay to re-emit the signal.
   */
  markAgentNotificationDispatched(notificationId: string): void {
    const identity = `agent_notification/${notificationId}`;
    this.db
      .update(agentNotificationDispatch)
      .set({ state: 'dispatched' })
      .where(eq(agentNotificationDispatch.identity, identity))
      .run();
  }

  /**
   * Push "session ready to control from your phone" the first time it is
   * claimed for this session. The caller (UserConnectionDO) invokes this when
   * a CLI heartbeat first reports the session as remote-controllable; the
   * `sessionReadyNotified` meta row here makes the push once-ever durable —
   * CLI reconnects and UserConnectionDO evictions can't re-arm it. Push
   * failures are non-fatal: log and move on.
   */
  claimSessionReadyPush(kiloUserId: string, sessionId: string, title?: string): void {
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
        title,
      }).catch((error: unknown) => {
        console.error('Failed to send session-ready push (non-fatal)', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
    );
  }

  /** Builds a text excerpt for a completed assistant message from its already-ingested text parts. */
  private buildAssistantExcerptForMessage(messageId: string): string {
    const range = getPartItemIdentityRange(messageId);
    const rows = this.db
      .select({
        item_data: ingestItems.item_data,
      })
      .from(ingestItems)
      .where(
        and(
          eq(ingestItems.item_type, 'part'),
          gte(ingestItems.item_id, range.start),
          lt(ingestItems.item_id, range.end),
          isNull(ingestItems.item_data_r2_key)
        )
      )
      .orderBy(ingestItems.ingested_at, ingestItems.id)
      .all();

    // Parts offloaded to R2 (oversized items) store '{}' inline; skip them rather
    // than fetching from R2 — this is a best-effort excerpt, not a full transcript.
    return buildAssistantExcerpt(rows.map(row => row.item_data));
  }

  /**
   * Finds the most recent completed assistant message id, scanning messages newest-first. Used to
   * pair an idle transition with the assistant turn that just finished so the `completed` attention
   * signal carries that turn's excerpt. R2-offloaded message rows (inline '{}') are skipped.
   *
   * The scan is bounded: the turn that just finished is effectively always among the newest
   * messages, and an unbounded scan would load every message row on every turn end.
   */
  private findLastCompletedAssistantMessageId(): string | null {
    const rows = this.db
      .select({
        item_data: ingestItems.item_data,
      })
      .from(ingestItems)
      .where(and(eq(ingestItems.item_type, 'message'), isNull(ingestItems.item_data_r2_key)))
      .orderBy(desc(ingestItems.ingested_at), desc(ingestItems.id))
      .limit(COMPLETED_MESSAGE_SCAN_LIMIT)
      .all();
    for (const row of rows) {
      const messageId = completedAssistantMessageIdFromItemData(row.item_data);
      if (messageId) return messageId;
    }
    return null;
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
   * Returns true if metrics were emitted, false if already emitted.
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

    // Best-effort persist the per-session total cost to Postgres so the session
    // list can surface it. Runs once per close under the metricsEmitted dedup.
    // Failures are logged and swallowed — must never break metrics emission.
    try {
      if (Number.isFinite(metrics.totalCost)) {
        const totalCostMicrodollars = Math.max(0, Math.round(metrics.totalCost * 1_000_000));
        await getWorkerDb(this.env.HYPERDRIVE.connectionString)
          .update(cli_sessions_v2)
          .set({ total_cost_microdollars: totalCostMicrodollars })
          .where(
            and(
              eq(cli_sessions_v2.session_id, sessionId),
              eq(cli_sessions_v2.kilo_user_id, kiloUserId)
            )
          );
      }
    } catch (error) {
      console.error('SessionIngestDO failed to persist session total cost', {
        sessionId,
        kiloUserId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }

    // Mark metrics as emitted to prevent duplicates
    this.db
      .insert(ingestMeta)
      .values({ key: 'metricsEmitted', value: 'true' })
      .onConflictDoUpdate({ target: ingestMeta.key, set: { value: 'true' } })
      .run();

    await this.ctx.storage.deleteAlarm();

    return true;
  }

  /**
   * Alarm fires either after POST_CLOSE_DRAIN_MS (session closed) or
   * INACTIVITY_TIMEOUT_MS (no activity). Reads the close reason from
   * ingest_meta if present, otherwise falls back to 'abandoned'.
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
        ])
      )
      .all();

    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));

    if (meta['deleted'] === 'true') return;

    const kiloUserId = meta['kiloUserId'];
    const sessionId = meta['sessionId'];

    if (!kiloUserId || !sessionId) return;

    const closeReason = (meta['closeReason'] ?? 'abandoned') as TerminationReason;
    const ingestVersion = Number(meta['ingestVersion'] ?? '0') || 0;

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
