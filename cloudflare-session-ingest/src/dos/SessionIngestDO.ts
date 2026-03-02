import { DurableObject } from 'cloudflare:workers';
import { eq, ne, inArray } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import { ingestItems, ingestMeta } from '../db/sqlite-schema';
import type { Env } from '../env';
import type { IngestBatch } from '../types/session-sync';
import type { SessionDataItem } from '../types/session-sync';
import { getItemIdentity } from '../util/compaction';
import { buildSharedSessionSnapshot } from '../util/share-output';
import {
  extractNormalizedGitBranchFromItem,
  extractNormalizedGitUrlFromItem,
  extractNormalizedOrgIdFromItem,
  extractNormalizedParentIdFromItem,
  extractNormalizedPlatformFromItem,
  extractNormalizedTitleFromItem,
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
  | 'metricsEmitted';

type ExtractableMetaKey = 'title' | 'parentId' | 'platform' | 'orgId' | 'gitUrl' | 'gitBranch';

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
    ingestVersion = 0
  ): Promise<{
    changes: Changes;
  }> {
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
    };

    let hasSessionOpen = false;
    let closeReason: string | undefined;

    for (const item of payload) {
      const { item_id, item_type } = getItemIdentity(item);

      const itemDataJson = JSON.stringify(item.data);

      this.db
        .insert(ingestItems)
        .values({ item_id, item_type, item_data: itemDataJson })
        .onConflictDoUpdate({
          target: ingestItems.item_id,
          set: { item_type, item_data: itemDataJson },
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

  async getAll(): Promise<string> {
    const rows = this.db
      .select({
        item_id: ingestItems.item_id,
        item_type: ingestItems.item_type,
        item_data: ingestItems.item_data,
      })
      .from(ingestItems)
      .where(ne(ingestItems.item_type, 'session_diff'))
      .orderBy(ingestItems.id)
      .all();

    const items: IngestBatch = [];
    for (const row of rows) {
      try {
        const parsedData: unknown = JSON.parse(row.item_data);

        // DB values are untyped; trust stored shape.
        items.push({
          type: row.item_type as SessionDataItem['type'],
          data: parsedData as SessionDataItem['data'],
        } as IngestBatch[number]);
      } catch {
        // Ignore corrupted rows; best-effort read.
      }
    }

    const snapshot = buildSharedSessionSnapshot(items);
    return JSON.stringify(snapshot);
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
      .where(inArray(ingestMeta.key, ['kiloUserId', 'sessionId', 'closeReason', 'ingestVersion']))
      .all();

    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
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

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await migrate(this.db, migrations);
  }
}

export function getSessionIngestDO(env: Env, params: { kiloUserId: string; sessionId: string }) {
  const doKey = `${params.kiloUserId}/${params.sessionId}`;
  const id = env.SESSION_INGEST_DO.idFromName(doKey);
  return env.SESSION_INGEST_DO.get(id);
}
