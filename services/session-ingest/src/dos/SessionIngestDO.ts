import { DurableObject } from 'cloudflare:workers';
import { eq, ne, gt, and, sql, inArray, isNotNull } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import { ingestItems, ingestMeta } from '../db/sqlite-schema';
import type { Env } from '../env';
import type { IngestBatch } from '../types/session-sync';
import type { SessionDataItem } from '../types/session-sync';
import { getItemIdentity } from '../util/compaction';
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

type IngestMetaKey =
  | ExtractableMetaKey
  | 'kiloUserId'
  | 'sessionId'
  | 'ingestVersion'
  | 'closeReason'
  | 'metricsEmitted'
  | 'deleted';

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
  ): Promise<{
    changes: Changes;
  }> {
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
      return { changes: [] };
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

    let hasSessionOpen = false;
    let closeReason: string | undefined;
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

      if (item.type === 'session_open') {
        hasSessionOpen = true;
      } else if (item.type === 'session_close') {
        closeReason = item.data.reason;
      }
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

    // Clean up orphaned R2 blobs (e.g. replaced or stale oversized items)
    if (orphanedR2Keys.length > 0) {
      await this.env.SESSION_INGEST_R2.delete(orphanedR2Keys);
    }

    if (ingestVersion >= 1) {
      // v1 clients send explicit open/close pairs. Only those events drive alarms.
      if (hasSessionOpen) {
        // New turn starting — clear prior emission so metrics are re-computed.
        this.db
          .delete(ingestMeta)
          .where(inArray(ingestMeta.key, ['metricsEmitted', 'closeReason']))
          .run();
        await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
      }
      if (closeReason) {
        writeIngestMetaIfChanged(this.db, { key: 'closeReason', incomingValue: closeReason });
        await this.ctx.storage.setAlarm(Date.now() + POST_CLOSE_DRAIN_MS);
      }
      // Events without open/close (stragglers) don't touch the alarm.
    } else {
      // v0 (legacy): no open/close signals, rely on inactivity timeout.
      await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
    }

    return {
      changes,
    };
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
          let msgCursor = 0;
          let firstMsg = true;

          while (true) {
            const msgBatch = db
              .select({
                id: ingestItems.id,
                item_id: ingestItems.item_id,
                item_data: ingestItems.item_data,
                item_data_r2_key: ingestItems.item_data_r2_key,
              })
              .from(ingestItems)
              .where(and(eq(ingestItems.item_type, 'message'), gt(ingestItems.id, msgCursor)))
              .orderBy(ingestItems.id)
              .limit(CURSOR_BATCH)
              .all();

            if (msgBatch.length === 0) break;
            msgCursor = msgBatch[msgBatch.length - 1].id;

            for (const msgRow of msgBatch) {
              if (!firstMsg) controller.enqueue(encoder.encode(','));
              firstMsg = false;

              // message info
              controller.enqueue(encoder.encode('{"info":'));
              await enqueueItemData(controller, msgRow, r2, encoder);

              // parts for this message: item_id = '{msgId}/{partId}'
              const msgId = msgRow.item_id.slice('message/'.length);
              // Escape LIKE wildcards (% and _) so they match literally, with ESCAPE clause
              const likePattern = msgId.replace(/[%_\\]/g, '\\$&') + '/%';
              controller.enqueue(encoder.encode(',"parts":['));
              let partCursor = 0;
              let firstPart = true;

              while (true) {
                const partBatch = db
                  .select({
                    id: ingestItems.id,
                    item_data: ingestItems.item_data,
                    item_data_r2_key: ingestItems.item_data_r2_key,
                  })
                  .from(ingestItems)
                  .where(
                    and(
                      eq(ingestItems.item_type, 'part'),
                      sql`${ingestItems.item_id} LIKE ${likePattern} ESCAPE '\\'`,
                      gt(ingestItems.id, partCursor)
                    )
                  )
                  .orderBy(ingestItems.id)
                  .limit(CURSOR_BATCH)
                  .all();

                if (partBatch.length === 0) break;
                partCursor = partBatch[partBatch.length - 1].id;

                for (const partRow of partBatch) {
                  if (!firstPart) controller.enqueue(encoder.encode(','));
                  firstPart = false;

                  await enqueueItemData(controller, partRow, r2, encoder);
                }
              }

              controller.enqueue(encoder.encode(']}'));
            }
          }

          controller.enqueue(encoder.encode(']}'));
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
      .orderBy(ingestItems.id)
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
  encoder: TextEncoder
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
      console.error('R2 blob missing during export, falling back to empty object', {
        r2Key: ref.item_data_r2_key,
      });
      controller.enqueue(encoder.encode('{}'));
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
