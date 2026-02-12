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
import {
  computeSessionMetrics,
  INACTIVITY_TIMEOUT_MS,
  POST_CLOSE_DRAIN_MS,
  type TerminationReason,
} from './session-metrics';

type IngestMetaKey =
  | ExtractableMetaKey
  | 'kiloUserId'
  | 'sessionId'
  | 'ingestVersion'
  | 'closeReason'
  | 'metricsEmitted';

type ExtractableMetaKey = 'title' | 'parentId' | 'platform' | 'orgId';

function writeIngestMetaIfChanged(
  sql: SqlStorage,
  params: { key: IngestMetaKey; incomingValue: string | null }
): { changed: boolean; value: string | null } {
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

const INGEST_META_EXTRACTORS: Array<{
  key: ExtractableMetaKey;
  extract: (item: IngestBatch[number]) => string | null | undefined;
}> = [
  { key: 'title', extract: extractNormalizedTitleFromItem },
  { key: 'parentId', extract: extractNormalizedParentIdFromItem },
  { key: 'platform', extract: extractNormalizedPlatformFromItem },
  { key: 'orgId', extract: extractNormalizedOrgIdFromItem },
];

type Changes = Array<{ name: ExtractableMetaKey; value: string | null }>;

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
    kiloUserId: string,
    sessionId: string,
    ingestVersion = 0
  ): Promise<{
    changes: Changes;
  }> {
    this.initSchema();

    // Persist identity and version so alarm() can recover after hibernation
    writeIngestMetaIfChanged(this.sql, { key: 'kiloUserId', incomingValue: kiloUserId });
    writeIngestMetaIfChanged(this.sql, { key: 'sessionId', incomingValue: sessionId });
    writeIngestMetaIfChanged(this.sql, {
      key: 'ingestVersion',
      incomingValue: String(ingestVersion),
    });

    const incomingByKey: Record<ExtractableMetaKey, string | null | undefined> = {
      title: undefined,
      parentId: undefined,
      platform: undefined,
      orgId: undefined,
    };

    let hasSessionOpen = false;
    let closeReason: string | undefined;

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
      const meta = writeIngestMetaIfChanged(this.sql, {
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
        this.sql.exec(`DELETE FROM ingest_meta WHERE key IN ('metricsEmitted', 'closeReason')`);
        await this.ctx.storage.setAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
      }
      if (closeReason) {
        writeIngestMetaIfChanged(this.sql, { key: 'closeReason', incomingValue: closeReason });
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
  private async emitSessionMetrics(
    kiloUserId: string,
    sessionId: string,
    closeReason: TerminationReason,
    ingestVersion: number
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

    const modelRow = this.sql
      .exec<{
        item_data: string;
      }>(`SELECT item_data FROM ingest_items WHERE item_id = 'model' LIMIT 1`)
      .toArray()[0];
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
    this.sql.exec(
      `INSERT INTO ingest_meta (key, value) VALUES ('metricsEmitted', 'true')
       ON CONFLICT(key) DO UPDATE SET value = 'true'`
    );

    await this.ctx.storage.deleteAlarm();

    return true;
  }

  /**
   * Alarm fires either after POST_CLOSE_DRAIN_MS (session closed) or
   * INACTIVITY_TIMEOUT_MS (no activity). Reads the close reason from
   * ingest_meta if present, otherwise falls back to 'abandoned'.
   */
  async alarm(): Promise<void> {
    this.initSchema();

    const metaRows = this.sql
      .exec<{
        key: string;
        value: string | null;
      }>(
        `SELECT key, value FROM ingest_meta WHERE key IN ('kiloUserId', 'sessionId', 'closeReason', 'ingestVersion')`
      )
      .toArray();

    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
    const kiloUserId = meta['kiloUserId'];
    const sessionId = meta['sessionId'];

    if (!kiloUserId || !sessionId) return;

    const closeReason = (meta['closeReason'] ?? 'abandoned') as TerminationReason;
    const ingestVersion = Number(meta['ingestVersion'] ?? '0') || 0;

    await this.emitSessionMetrics(kiloUserId, sessionId, closeReason, ingestVersion);
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
