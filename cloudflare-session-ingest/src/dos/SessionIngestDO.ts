import { DurableObject } from 'cloudflare:workers';

import type { Env } from '../env';
import type { IngestBatch } from '../types/session-sync';
import type { SessionDataItem } from '../types/session-sync';
import { getItemIdentity } from '../util/compaction';
import { buildSharedSessionSnapshot } from '../util/share-output';
import {
  extractNormalizedOrgIdFromItem,
  extractNormalizedParentIdFromItem,
  extractNormalizedPlatformFromItem,
  extractNormalizedTitleFromItem,
} from './session-ingest-extractors';
import { computeSessionMetrics, INACTIVITY_TIMEOUT_MS } from './session-metrics';

function writeIngestMetaIfChanged(
  sql: SqlStorage,
  params: { key: string; incomingValue: string | null | undefined }
): { changed: boolean; value: string | null } {
  if (params.incomingValue === undefined) {
    return { changed: false, value: null };
  }

  const existing = sql
    .exec<{
      value: string | null;
    }>('SELECT value FROM ingest_meta WHERE key = ? LIMIT 1', params.key)
    .toArray();
  const currentValue = existing[0]?.value ?? null;

  if (currentValue === params.incomingValue) {
    return { changed: false, value: params.incomingValue };
  }

  sql.exec(
    `
      INSERT INTO ingest_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
    params.key,
    params.incomingValue
  );

  return { changed: true, value: params.incomingValue };
}

type IngestMetaKey = 'title' | 'parentId' | 'platform' | 'orgId';

const INGEST_META_EXTRACTORS: Array<{
  key: IngestMetaKey;
  extract: (item: IngestBatch[number]) => string | null | undefined;
}> = [
  { key: 'title', extract: extractNormalizedTitleFromItem },
  { key: 'parentId', extract: extractNormalizedParentIdFromItem },
  { key: 'platform', extract: extractNormalizedPlatformFromItem },
  { key: 'orgId', extract: extractNormalizedOrgIdFromItem },
];

type Changes = Array<{ name: IngestMetaKey; value: string | null }>;

export class SessionIngestDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.sql = state.storage.sql;

    void state.blockConcurrencyWhile(async () => {
      this.initSchema();
    });
  }

  private initSchema() {
    if (this.initialized) {
      return;
    }

    this.sql.exec(/* sql */ `
      CREATE TABLE IF NOT EXISTS ingest_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT NOT NULL UNIQUE,
        item_type TEXT NOT NULL,
        item_data TEXT NOT NULL
      );
    `);

    this.sql.exec(/* sql */ `
      CREATE TABLE IF NOT EXISTS ingest_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    this.initialized = true;
  }

  async ingest(
    payload: IngestBatch,
    clientIp: string | null,
    kiloUserId: string,
    sessionId: string
  ): Promise<{
    changes: Changes;
    hasSessionClose: boolean;
  }> {
    this.initSchema();

    // Persist identity so alarm() can recover kiloUserId/sessionId after hibernation
    writeIngestMetaIfChanged(this.sql, { key: 'kiloUserId', incomingValue: kiloUserId });
    writeIngestMetaIfChanged(this.sql, { key: 'sessionId', incomingValue: sessionId });

    const incomingByKey: Record<IngestMetaKey, string | null | undefined> = {
      title: undefined,
      parentId: undefined,
      platform: undefined,
      orgId: undefined,
    };

    let hasSessionClose = false;

    for (const item of payload) {
      const { item_id, item_type } = getItemIdentity(item);

      const itemDataJson = JSON.stringify(item.data);

      this.sql.exec(
        `
          INSERT INTO ingest_items (item_id, item_type, item_data)
          VALUES (?, ?, ?)
          ON CONFLICT(item_id) DO UPDATE SET
            item_type = excluded.item_type,
            item_data = excluded.item_data
        `,
        item_id,
        item_type,
        itemDataJson
      );

      for (const extractor of INGEST_META_EXTRACTORS) {
        const maybeValue = extractor.extract(item);
        if (maybeValue !== undefined) {
          incomingByKey[extractor.key] = maybeValue;
        }
      }

      if (item.type === 'session_close') {
        hasSessionClose = true;
      }
    }

    const changes: Changes = [];

    for (const key of Object.keys(incomingByKey) as IngestMetaKey[]) {
      const meta = writeIngestMetaIfChanged(this.sql, {
        key,
        incomingValue: incomingByKey[key],
      });
      if (meta.changed) {
        changes.push({ name: key, value: meta.value });
      }
    }

    // If new session data arrives after metrics were already emitted (e.g. a
    // user resumes a session the next day), clear the flag so the next
    // close/alarm re-computes and re-emits.
    if (!hasSessionClose) {
      this.sql.exec(`DELETE FROM ingest_meta WHERE key = 'metricsEmitted'`);
    }

    // Store (or clear) the client IP so metrics emission forwards the latest value
    writeIngestMetaIfChanged(this.sql, { key: 'clientIp', incomingValue: clientIp });

    // Reset the inactivity alarm unless the session just closed (metrics will
    // be emitted by the API handler and the alarm deleted there).
    if (!hasSessionClose) {
      await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
    }

    return {
      changes,
      hasSessionClose,
    };
  }

  async getAll(): Promise<string> {
    this.initSchema();

    const rows = this.sql
      .exec('SELECT item_id, item_type, item_data FROM ingest_items ORDER BY id')
      .toArray() as Array<{ item_id: string; item_type: string; item_data: string }>;

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
  async emitSessionMetrics(
    kiloUserId: string,
    sessionId: string,
    closeReason: 'completed' | 'error' | 'user_closed' | 'abandoned' | null
  ): Promise<boolean> {
    this.initSchema();

    // Check if metrics have already been emitted
    const emittedRows = this.sql
      .exec<{
        value: string | null;
      }>(`SELECT value FROM ingest_meta WHERE key = 'metricsEmitted' LIMIT 1`)
      .toArray();
    if (emittedRows[0]?.value === 'true') {
      return false;
    }

    const rows = this.sql
      .exec<{
        item_type: string;
        item_data: string;
      }>('SELECT item_type, item_data FROM ingest_items')
      .toArray();

    // Skip emission if the session has no meaningful data
    if (rows.length === 0) {
      return false;
    }

    const metrics = computeSessionMetrics(rows, closeReason);

    // Read stored client IP for PostHog geo-IP forwarding
    const ipRows = this.sql
      .exec<{
        value: string | null;
      }>(`SELECT value FROM ingest_meta WHERE key = 'clientIp' LIMIT 1`)
      .toArray();
    const clientIp = ipRows[0]?.value ?? null;

    await this.env.O11Y.ingestSessionMetrics({
      kiloUserId,
      sessionId,
      organizationId: metrics.organizationId,
      platform: metrics.platform,
      ipAddress: clientIp,
      sessionDurationMs: metrics.sessionDurationMs,
      timeToFirstResponseMs: metrics.timeToFirstResponseMs,
      totalTurns: metrics.totalTurns,
      totalSteps: metrics.totalSteps,
      toolCallsByType: metrics.toolCallsByType,
      toolErrorsByType: metrics.toolErrorsByType,
      totalErrors: metrics.totalErrors,
      errorsByType: metrics.errorsByType,
      stuckToolCallCount: metrics.stuckToolCallCount,
      totalTokens: metrics.totalTokens,
      totalCost: metrics.totalCost,
      compactionCount: metrics.compactionCount,
      autoCompactionCount: metrics.autoCompactionCount,
      terminationReason: metrics.terminationReason,
    });

    // Mark metrics as emitted to prevent duplicates
    this.sql.exec(
      `INSERT INTO ingest_meta (key, value) VALUES ('metricsEmitted', 'true')
       ON CONFLICT(key) DO UPDATE SET value = 'true'`
    );

    await this.ctx.storage.deleteAlarm();

    return true;
  }

  /**
   * Alarm fires after INACTIVITY_TIMEOUT_MS of no ingest activity.
   * Emit metrics with 'abandoned' reason as fallback.
   */
  async alarm(): Promise<void> {
    this.initSchema();

    const metaRows = this.sql
      .exec<{
        key: string;
        value: string | null;
      }>(`SELECT key, value FROM ingest_meta WHERE key IN ('kiloUserId', 'sessionId')`)
      .toArray();

    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
    const kiloUserId = meta['kiloUserId'];
    const sessionId = meta['sessionId'];

    if (!kiloUserId || !sessionId) return;

    try {
      await this.emitSessionMetrics(kiloUserId, sessionId, 'abandoned');
    } catch (err) {
      console.error('Failed to emit session metrics from alarm', { error: err });
    }
  }

  async clear(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();

    this.initialized = false;
  }
}

export function getSessionIngestDO(env: Env, params: { kiloUserId: string; sessionId: string }) {
  const doKey = `${params.kiloUserId}/${params.sessionId}`;
  const id = env.SESSION_INGEST_DO.idFromName(doKey);
  return env.SESSION_INGEST_DO.get(id);
}
