import { DurableObject } from 'cloudflare:workers';
import {
  getSessionShareExpiresAt,
  sessionIdSchema,
  sessionShareDurationSchema,
  sessionLiveSummarySchema,
  type SessionShareDuration,
  type SessionLiveSummary,
} from '@kilocode/session-ingest-contracts';
import { sha256Hex } from '@kilocode/worker-utils/sha256';
import {
  desc,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  and,
  or,
  inArray,
  isNull,
  isNotNull,
  like,
  sql,
  type SQL,
} from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';

import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { ingestItems, ingestMeta, agentNotificationDispatch } from '../db/sqlite-schema';
import type { Env } from '../env';
import { MAX_INGEST_ITEM_BYTES } from '../util/ingest-limits';
import type { IngestBatch } from '../types/session-sync';
import type { SessionDataItem } from '../types/session-sync';
import {
  getItemIdentity,
  getPreviousPartItemIdentity,
  streamMessagePartRows,
} from '../util/compaction';
import { isItemWithinMessageCut } from '../util/message-cut';
import {
  extractNormalizedGitBranchFromItem,
  extractNormalizedGitUrlFromItem,
  extractNormalizedOrgIdFromItem,
  extractNormalizedParentIdFromItem,
  extractNormalizedPlatformFromItem,
  extractNormalizedTitleFromItem,
  extractSessionPrLink,
  extractStatusFromItem,
  extractStatusOccurredAtFromItem,
  extractStatusTransitionIdFromItem,
} from './session-ingest-extractors';
import {
  attentionKindForNeedsInputStatus,
  buildAssistantExcerpt,
  completedAssistantMessageIdFromItemData,
  isCompletedStatus,
  isNeedsInputStatus,
  type AttentionSignal,
} from './session-ingest-attention';
import {
  adjustRunningAssistantCostUsd,
  assistantMessageCostUsd,
  computeRunningAssistantCostUsd,
  computeSessionMetrics,
  COST_PERSIST_THROTTLE_MS,
  decideLivePersist,
  INACTIVITY_TIMEOUT_MS,
  POST_CLOSE_DRAIN_MS,
  RUNNING_ASSISTANT_COST_META_KEY,
  runningAssistantCostMicrodollars,
  storedAssistantMessageCostUsd,
  type TerminationReason,
} from './session-metrics';
import migrations from '../../drizzle/migrations';
import { refreshGlanceableSessions } from '../remote-session-notifications';
import {
  applySessionLiveSummaryStatus,
  decideLiveSummaryPersist,
  EMPTY_SESSION_LIVE_SUMMARY_STATE,
  foldSessionLiveSummary,
  sessionLiveSummaryChanged,
  type SessionLiveSummaryState,
} from './session-live-summary';
import {
  readKiloSdkMessages,
  readKiloSdkSessionSnapshot,
  readSessionDiff,
  type KiloSdkSessionSnapshotRead,
} from './kilo-sdk-materialization';
import type { SessionDiffRead } from '@kilocode/session-ingest-contracts';
import { precedesStatusTransition, resetAttentionStatusOnCliDisconnect } from '../ingest/metadata';
import {
  BRIEFING_MAX_INLINE_BYTES,
  BRIEFING_MAX_EXCERPT_SOURCE_ROWS,
  briefingExcerptUpdate,
  buildBriefingExcerpt,
  completedBriefingResponse,
  isFinalizedBriefingText,
  type BriefingExcerpt,
} from '../ingest/briefing-excerpt';
import {
  SHARE_INFO_KEY_PREFIX,
  shareInfoKey,
  readShareInfo,
  projectSharedSessionInfo,
  type ShareInfoMetaKey,
} from './session-share-info';

type LiveThrottleMetaKey =
  | 'lastActivityValueMs'
  | 'lastActivityPersistedAtMs'
  | 'lastActivityPersistedValueMs'
  | 'lastCostPersistedAtMs'
  | 'lastCostPersistedMicrodollars'
  | 'lastLiveSummaryPersistedAtMs';

type AlarmMetaKey = 'metricsAlarmAt';

type NumericMetaKey = LiveThrottleMetaKey | AlarmMetaKey | typeof RUNNING_ASSISTANT_COST_META_KEY;

type IngestMetaKey =
  | ExtractableMetaKey
  | 'kiloUserId'
  | 'sessionId'
  | 'ingestVersion'
  | 'closeReason'
  | 'metricsEmitted'
  | 'deleted'
  | 'sessionReadyNotified'
  | 'liveSummaryState'
  | 'lastLiveSummaryPersisted'
  | NumericMetaKey
  | ShareInfoMetaKey;

export const SHARE_INFO_TOO_LARGE_ERROR = 'Share snapshot is too large';

type ExtractableMetaKey =
  | 'title'
  | 'parentId'
  | 'platform'
  | 'orgId'
  | 'gitUrl'
  | 'gitBranch'
  | 'status'
  | 'statusOccurredAt'
  | 'statusTransitionId'
  | 'prPlatform'
  | 'prUrl'
  | 'prNumber'
  | 'prHeadRef'
  | 'prHeadSha';

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

function readIngestMetaValue(db: DrizzleSqliteDODatabase, key: IngestMetaKey): string | null {
  const row = db
    .select({ value: ingestMeta.value })
    .from(ingestMeta)
    .where(eq(ingestMeta.key, key))
    .get();
  return row?.value ?? null;
}

function writeIngestMetaValue(
  db: DrizzleSqliteDODatabase,
  key: IngestMetaKey,
  value: string
): void {
  db.insert(ingestMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: ingestMeta.key, set: { value } })
    .run();
}

/** The running summary the previous batches left, or the empty value. */
function readLiveSummaryState(db: DrizzleSqliteDODatabase): SessionLiveSummaryState {
  const raw = readIngestMetaValue(db, 'liveSummaryState');
  if (raw === null) return EMPTY_SESSION_LIVE_SUMMARY_STATE;
  const parsed = sessionLiveSummarySchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : EMPTY_SESSION_LIVE_SUMMARY_STATE;
}

/** The value the last successful persist wrote, or null when none did. */
function readLiveSummaryPersisted(db: DrizzleSqliteDODatabase): SessionLiveSummary | null {
  const raw = readIngestMetaValue(db, 'lastLiveSummaryPersisted');
  if (raw === null) return null;
  const parsed = sessionLiveSummarySchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

function readIngestMetaNumber(db: DrizzleSqliteDODatabase, key: NumericMetaKey): number | null {
  const row = db
    .select({ value: ingestMeta.value })
    .from(ingestMeta)
    .where(eq(ingestMeta.key, key))
    .get();
  if (row?.value === null || row?.value === undefined) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

function writeIngestMetaNumber(
  db: DrizzleSqliteDODatabase,
  key: NumericMetaKey,
  value: number
): void {
  const serialized = String(value);
  db.insert(ingestMeta)
    .values({ key, value: serialized })
    .onConflictDoUpdate({ target: ingestMeta.key, set: { value: serialized } })
    .run();
}

type CloneMetaKey =
  | 'cloneSourceSessionId'
  | 'cloneDestinationSessionId'
  | 'cloneNextCursor'
  | 'cloneRollingDigest'
  | 'cloneCopiedItemCount'
  | 'cloneCompleteSourceId'
  | 'cloneUpToMessageId';

function readCloneMeta(db: DrizzleSqliteDODatabase, key: CloneMetaKey): string | null {
  const row = db
    .select({ value: ingestMeta.value })
    .from(ingestMeta)
    .where(eq(ingestMeta.key, key))
    .get();
  return row?.value ?? null;
}

function writeCloneMeta(db: DrizzleSqliteDODatabase, key: CloneMetaKey, value: string): void {
  db.insert(ingestMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: ingestMeta.key, set: { value } })
    .run();
}

/**
 * Monotonic live-column write for cost, last_activity_at, and the session
 * card summary. Per-column CASE guards so concurrent waitUntil tasks commute.
 * Used by live ingest persists and the close-path emitSessionMetrics write.
 *
 * The summary has no order of its own, so it carries the activity time of
 * the batch that produced it (`atIso`) and is written only when that time is
 * not older than the stored activity. A slower in-flight write of an older
 * batch then leaves the newer summary in place, as the activity guard does.
 */
export async function persistLiveSessionColumns(
  connectionString: string,
  kiloUserId: string,
  sessionId: string,
  columns: {
    costMicrodollars?: number;
    lastActivityAtIso?: string;
    liveSummary?: { summary: SessionLiveSummary; atIso: string };
    briefingExcerpt?: { excerpt: BriefingExcerpt; receivedAtIso: string };
  }
): Promise<void> {
  const set: {
    total_cost_microdollars?: SQL;
    last_activity_at?: SQL;
    live_summary?: SQL;
    briefing_excerpt?: SQL;
  } = {};

  if (columns.costMicrodollars !== undefined) {
    const cost = columns.costMicrodollars;
    set.total_cost_microdollars = sql`CASE
      WHEN ${cli_sessions_v2.total_cost_microdollars} IS NULL
        OR ${cli_sessions_v2.total_cost_microdollars} < ${cost}
      THEN ${cost}
      ELSE ${cli_sessions_v2.total_cost_microdollars}
    END`;
  }

  if (columns.lastActivityAtIso !== undefined) {
    const activity = columns.lastActivityAtIso;
    set.last_activity_at = sql`CASE
      WHEN ${cli_sessions_v2.last_activity_at} IS NULL
        OR ${cli_sessions_v2.last_activity_at} < ${activity}
      THEN ${activity}
      ELSE ${cli_sessions_v2.last_activity_at}
    END`;
  }

  if (columns.liveSummary !== undefined) {
    // Postgres reads every SET expression against the old row, so this guard
    // compares with the stored activity, not the value set beside it.
    const { summary, atIso } = columns.liveSummary;
    set.live_summary = sql`CASE
      WHEN ${cli_sessions_v2.last_activity_at} IS NULL
        OR ${cli_sessions_v2.last_activity_at} <= ${atIso}
      THEN ${JSON.stringify(summary)}::jsonb
      ELSE ${cli_sessions_v2.live_summary}
    END`;
  }

  if (columns.briefingExcerpt !== undefined) {
    const { excerpt, receivedAtIso } = columns.briefingExcerpt;
    set.briefing_excerpt = briefingExcerptUpdate(excerpt, receivedAtIso);
  }

  if (Object.keys(set).length === 0) return;

  await getWorkerDb(connectionString)
    .update(cli_sessions_v2)
    .set(set)
    .where(
      and(eq(cli_sessions_v2.session_id, sessionId), eq(cli_sessions_v2.kilo_user_id, kiloUserId))
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
  { key: 'statusOccurredAt', extract: extractStatusOccurredAtFromItem },
  { key: 'statusTransitionId', extract: extractStatusTransitionIdFromItem },
];

type Changes = Array<{ name: ExtractableMetaKey; value: string | null }>;

export type IngestResult =
  | { accepted: true; changes: Changes; attentionSignals: AttentionSignal[] }
  | { accepted: false; reason: 'deleted'; changes: never[] };
/** How many of the newest message rows to inspect when pairing an idle transition with the assistant turn that just finished. */
const COMPLETED_MESSAGE_SCAN_LIMIT = 50;

/** Part rows read per batch when building the excerpt a completed turn's push carries. */
const EXCERPT_PART_BATCH_SIZE = 256;

type PartExcerptRow = {
  id: number;
  ingested_at: number | null;
  item_id: string;
  item_data: string;
};

type PartExportRow = {
  id: number;
  ingested_at: number | null;
  item_id: string;
  item_data: string;
  item_data_r2_key: string | null;
};

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

export type CloneItemType = 'session' | 'message' | 'part' | 'session_diff';

export const CLONE_ITEM_TYPES: CloneItemType[] = ['session', 'message', 'part', 'session_diff'];

export type CloneBatchRow = {
  itemId: string;
  itemType: CloneItemType;
  itemData: string;
  itemDataR2Key: string | null;
  ingestedAt: number | null;
};

export type ExportCloneBatchResult = {
  rows: CloneBatchRow[];
  nextCursor: IngestOrderCursor | null;
  done: boolean;
  digest: string;
};

/**
 * A clone stage is identified by source, destination, and the optional
 * inclusive message cut. Absent `upToMessageId` means the full transcript.
 */
export type CloneStageIdentity = {
  sourceSessionId: string;
  destinationSessionId: string;
  upToMessageId?: string;
};

export type StageCloneBatchParams = CloneStageIdentity & {
  rows: CloneBatchRow[];
  nextCursor: IngestOrderCursor | null;
  rollingDigest: string;
  copiedItemCount: number;
};

export type StageCloneBatchResult =
  | {
      status: 'staged';
      sourceSessionId: string;
      destinationSessionId: string;
      nextCursor: IngestOrderCursor | null;
      rollingDigest: string;
      copiedItemCount: number;
    }
  | { status: 'complete'; sourceSessionId: string; destinationSessionId: string }
  | {
      status: 'mismatch';
      storedSourceSessionId: string | null;
      storedDestinationSessionId: string | null;
    };

export type InspectCloneStageParams = CloneStageIdentity;

export type InspectCloneStageResult =
  | { status: 'empty' }
  | { status: 'complete'; sourceSessionId: string; destinationSessionId: string }
  | {
      status: 'in_progress';
      sourceSessionId: string;
      destinationSessionId: string;
      nextCursor: IngestOrderCursor | null;
      rollingDigest: string;
      copiedItemCount: number;
    }
  | {
      status: 'mismatch';
      storedSourceSessionId: string | null;
      storedDestinationSessionId: string | null;
      storedStage: 'complete' | 'in_progress';
    };

export type FinalizeCloneStageParams = CloneStageIdentity & {
  finalDigest: string;
  finalItemCount: number;
};

export type FinalizeCloneStageResult =
  | { status: 'complete'; sourceSessionId: string; destinationSessionId: string }
  | {
      status: 'mismatch';
      storedSourceSessionId: string | null;
      storedDestinationSessionId: string | null;
    }
  | {
      status: 'digest_mismatch';
      expectedDigest: string;
      actualDigest: string;
      expectedItemCount: number;
      actualItemCount: number;
    }
  | { status: 'empty' };

type CloneStageState =
  | { kind: 'empty' }
  | {
      kind: 'complete';
      sourceSessionId: string;
      destinationSessionId: string;
      upToMessageId: string | null;
    }
  | {
      kind: 'in_progress';
      sourceSessionId: string;
      destinationSessionId: string;
      upToMessageId: string | null;
      nextCursor: IngestOrderCursor | null;
      rollingDigest: string;
      copiedItemCount: number;
    };

/** A stage built for another source, destination, or cut is a different clone. */
function isSameCloneStage(
  stage: Exclude<CloneStageState, { kind: 'empty' }>,
  params: CloneStageIdentity
): boolean {
  return (
    stage.sourceSessionId === params.sourceSessionId &&
    stage.destinationSessionId === params.destinationSessionId &&
    stage.upToMessageId === (params.upToMessageId ?? null)
  );
}

async function computeCloneBatchDigest(rows: CloneBatchRow[]): Promise<string> {
  const joined = rows
    .map(row => `${row.itemId}:${row.itemType}:${row.itemDataR2Key ?? row.itemData}`)
    .join('\n');
  return sha256Hex(joined);
}

export class SessionIngestDO extends DurableObject<Env> {
  private db: DrizzleSqliteDODatabase;
  private readonly activeR2Writes = new Set<Promise<unknown>>();
  private cleanupOperation: Promise<void> | undefined;

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
      statusOccurredAt: undefined,
      statusTransitionId: undefined,
      prPlatform: undefined,
      prUrl: undefined,
      prNumber: undefined,
      prHeadRef: undefined,
      prHeadSha: undefined,
    };

    const lifecycleEvents: IngestLifecycleEvent[] = [];
    const orphanedR2Keys: string[] = [];
    // Executed upserts only (not stale-skipped). Activity = message|part; cost gate = message.
    let wroteActivityItem = false;
    let wroteAssistantMessageItem = false;
    // Sums of the message-row costs this batch replaces and stores, in USD. The running
    // session cost moves by (added - replaced) instead of re-reading the whole history.
    let replacedMessageCostUsd = 0;
    let addedMessageCostUsd = 0;
    // §4.10: in-batch {notificationId -> message} so the post-loop signal builder can
    // re-emit on replay without re-reading item_data from SQLite.
    const pendingAgentNotifications = new Map<string, string>();

    // The items this batch actually stored. The session card summary folds
    // only these: a stale item is an older version of a row the DO already
    // holds a newer one of, and folding it would move the summary back (an
    // old running state of a tool that already finished would revive its step).
    const storedItems: IngestBatch[number][] = [];

    // The stored rows and the running cost total commit together. A request that fails after
    // storing rows must not leave their contributions missing from the total: a retried batch
    // replaces identical rows, so it moves nothing, and a total that exists is never re-seeded.
    this.ctx.storage.transactionSync(() => {
      for (const item of payload) {
        const { item_id, item_type } = getItemIdentity(item);

        // The row this item replaces. A message row's body decides its cost contribution, so
        // message items read it with the body; other items read only what the stale guard needs.
        const replacedMessageRow =
          item.type === 'message'
            ? this.db
                .select({
                  ingested_at: ingestItems.ingested_at,
                  item_data: ingestItems.item_data,
                  item_data_r2_key: ingestItems.item_data_r2_key,
                })
                .from(ingestItems)
                .where(eq(ingestItems.item_id, item_id))
                .get()
            : undefined;
        const replacedItemRow =
          item.type === 'message' || ingestedAt === undefined
            ? undefined
            : this.db
                .select({
                  ingested_at: ingestItems.ingested_at,
                  item_data_r2_key: ingestItems.item_data_r2_key,
                })
                .from(ingestItems)
                .where(eq(ingestItems.item_id, item_id))
                .get();
        const replacedRow = replacedMessageRow ?? replacedItemRow;

        // Check timestamp guard: skip if existing row has a newer ingested_at.
        // Also read the existing R2 key so we can clean up orphaned blobs.
        if (ingestedAt !== undefined) {
          const existingIngestedAt = replacedRow?.ingested_at;
          const existingR2Key = replacedRow?.item_data_r2_key;
          const previousItem =
            item.type === 'part'
              ? this.db
                  .select({ ingested_at: ingestItems.ingested_at })
                  .from(ingestItems)
                  .where(
                    and(
                      eq(
                        ingestItems.item_id,
                        getPreviousPartItemIdentity(item.data.messageID, item.data.id)
                      ),
                      eq(ingestItems.item_type, 'part')
                    )
                  )
                  .get()
              : undefined;
          const existingIsNewer =
            existingIngestedAt !== null &&
            existingIngestedAt !== undefined &&
            existingIngestedAt > ingestedAt;
          const previousIsNewer =
            previousItem?.ingested_at !== null &&
            previousItem?.ingested_at !== undefined &&
            previousItem.ingested_at > ingestedAt;
          if (existingIsNewer || previousIsNewer) {
            // Item is stale — if the caller wrote an R2 blob for it, that blob is orphaned
            const newR2Key = r2References?.[item_id];
            if (newR2Key) orphanedR2Keys.push(newR2Key);
            continue;
          }
          // If the existing row pointed to a different R2 blob, it will be orphaned after upsert
          const newR2Key = r2References?.[item_id] ?? null;
          if (existingR2Key && existingR2Key !== newR2Key) {
            orphanedR2Keys.push(existingR2Key);
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
        if (item.type === 'part') {
          // A part row can also exist under the older `<messageID>/<partID>` id. The row just
          // written supersedes it, so remove it to leave one row per part; the item-type and
          // timestamp guards keep the delete on a superseded copy of the same part.
          const superseded = this.db
            .delete(ingestItems)
            .where(
              and(
                eq(
                  ingestItems.item_id,
                  getPreviousPartItemIdentity(item.data.messageID, item.data.id)
                ),
                eq(ingestItems.item_type, 'part'),
                ingestedAt === undefined
                  ? undefined
                  : or(isNull(ingestItems.ingested_at), lte(ingestItems.ingested_at, ingestedAt))
              )
            )
            .returning({ item_data_r2_key: ingestItems.item_data_r2_key })
            .all();
          for (const row of superseded) {
            if (row.item_data_r2_key) orphanedR2Keys.push(row.item_data_r2_key);
          }
        }
        storedItems.push(item);

        if (item.type === 'message' || item.type === 'part') {
          wroteActivityItem = true;
        }
        // Cost gate is assistant-only (computeRunningAssistantCostUsd sums role:assistant).
        // data is looseObject — role is optional at the type level; cheap property check, no parse.
        if (item.type === 'message' && (item.data as { role?: unknown }).role === 'assistant') {
          wroteAssistantMessageItem = true;
        }
        // An offloaded body is not scanned, so it contributes nothing — the same rule the
        // full recomputation applies to a stored row.
        if (item.type === 'message') {
          replacedMessageCostUsd += storedAssistantMessageCostUsd(replacedMessageRow);
          addedMessageCostUsd += itemDataR2Key === null ? assistantMessageCostUsd(item.data) : 0;
        }

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

        const olderThanIncomingStatus =
          item.type === 'session_status' &&
          precedesStatusTransition(
            {
              occurredAt: item.data.occurredAt ?? null,
              transitionId: item.data.transitionId ?? null,
            },
            {
              occurredAt: incomingByKey.statusOccurredAt ?? null,
              transitionId: incomingByKey.statusTransitionId ?? null,
            }
          );
        for (const extractor of INGEST_META_EXTRACTORS) {
          if (
            olderThanIncomingStatus &&
            (extractor.key === 'status' ||
              extractor.key === 'statusOccurredAt' ||
              extractor.key === 'statusTransitionId')
          )
            continue;
          const maybeValue = extractor.extract(item);
          if (maybeValue !== undefined) {
            incomingByKey[extractor.key] = maybeValue;
          }
        }

        // session_pr_link emits the whole tuple atomically (or nothing), so the change
        // map always receives all five keys together.
        const prLink = extractSessionPrLink(item);
        if (prLink !== undefined) {
          incomingByKey.prPlatform = prLink.prPlatform;
          incomingByKey.prUrl = prLink.prUrl;
          incomingByKey.prNumber = prLink.prNumber;
          incomingByKey.prHeadRef = prLink.prHeadRef;
          incomingByKey.prHeadSha = prLink.prHeadSha;
        }

        if (ingestVersion >= 1) {
          if (item.type === 'session_open') {
            lifecycleEvents.push({ type: 'session_open' });
          } else if (item.type === 'session_close') {
            lifecycleEvents.push({ type: 'session_close', reason: item.data.reason });
          }
        }
      }

      // Same transaction as the rows, so the total cannot miss a stored contribution.
      const priorRunningCostUsd = readIngestMetaNumber(this.db, RUNNING_ASSISTANT_COST_META_KEY);
      if (priorRunningCostUsd !== null && replacedMessageCostUsd !== addedMessageCostUsd) {
        writeIngestMetaNumber(
          this.db,
          RUNNING_ASSISTANT_COST_META_KEY,
          adjustRunningAssistantCostUsd(
            priorRunningCostUsd,
            replacedMessageCostUsd,
            addedMessageCostUsd
          )
        );
      }
    });

    // Lifecycle side effects (metrics alarm, open/close meta) run before any incoming
    // metadata is committed, so a failed alarm write leaves that metadata unreported.
    if (this.isDeleted()) return { accepted: false, reason: 'deleted', changes: [] };
    if (ingestVersion >= 1) {
      // v1 clients send explicit open/close pairs. Only those events drive alarms.
      for (const event of lifecycleEvents) {
        if (this.isDeleted()) return { accepted: false, reason: 'deleted', changes: [] };
        if (event.type === 'session_open') {
          // New turn starting — clear prior emission so metrics are re-computed.
          this.db
            .delete(ingestMeta)
            .where(inArray(ingestMeta.key, ['metricsEmitted', 'closeReason']))
            .run();
          await this.scheduleAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
        } else {
          writeIngestMetaIfChanged(this.db, {
            key: 'closeReason',
            incomingValue: event.reason,
          });
          await this.scheduleAlarm(Date.now() + POST_CLOSE_DRAIN_MS);
        }
      }
      // Events without open/close (stragglers) don't touch the alarm.
    } else {
      // v0 (legacy): no open/close signals, rely on inactivity timeout.
      await this.scheduleAlarm(Date.now() + INACTIVITY_TIMEOUT_MS);
    }

    // Read before the write loop below persists incoming values: whether this session had ever
    // reported a status. The first-ever status write also registers as a change, and a
    // full-history backfill of an already-idle session must not push about an old turn.
    const hadPriorStatus = hasIngestMeta(this.db, 'status');
    const previousStatusOccurredAt = incomingByKey.statusOccurredAt
      ? readIngestMetaValue(this.db, 'statusOccurredAt')
      : null;
    const previousStatusTransitionId = incomingByKey.statusOccurredAt
      ? readIngestMetaValue(this.db, 'statusTransitionId')
      : null;
    const historicalStatus =
      incomingByKey.statusOccurredAt != null &&
      precedesStatusTransition(
        {
          occurredAt: incomingByKey.statusOccurredAt,
          transitionId: incomingByKey.statusTransitionId ?? null,
        },
        { occurredAt: previousStatusOccurredAt, transitionId: previousStatusTransitionId }
      );

    const changes: Changes = [];
    for (const key of Object.keys(incomingByKey) as ExtractableMetaKey[]) {
      if (
        historicalStatus &&
        (key === 'status' || key === 'statusOccurredAt' || key === 'statusTransitionId')
      )
        continue;
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
    const localStatusChange = changes.find(change => change.name === 'status');
    if (
      incomingByKey.status !== undefined &&
      (historicalStatus ||
        changes.some(
          change =>
            change.name === 'status' ||
            change.name === 'statusOccurredAt' ||
            change.name === 'statusTransitionId'
        ))
    ) {
      if (!changes.some(change => change.name === 'status')) {
        changes.push({ name: 'status', value: incomingByKey.status });
      }
      if (!changes.some(change => change.name === 'statusOccurredAt')) {
        changes.push({ name: 'statusOccurredAt', value: incomingByKey.statusOccurredAt ?? null });
      }
      if (!changes.some(change => change.name === 'statusTransitionId')) {
        changes.push({
          name: 'statusTransitionId',
          value: incomingByKey.statusTransitionId ?? null,
        });
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

    // Live activity + cost Postgres persist (items 7 + 17). Not via applyMetadataChanges
    // (avoids per-tick WS fanout). Throttle meta advances only after a successful write.
    const statusChangeForLive = localStatusChange;
    const idleTransition =
      statusChangeForLive !== undefined && isCompletedStatus(statusChangeForLive.value);
    const statusValue = statusChangeForLive?.value ?? readIngestMetaValue(this.db, 'status');
    const nowMsLive = Date.now();

    // Session card summary: fold this batch into the running value and apply
    // the status transition. Only the derived summary leaves the DO.
    const priorLiveSummary = readLiveSummaryState(this.db);
    const foldedLiveSummary = foldSessionLiveSummary(priorLiveSummary, storedItems, statusValue);
    const currentLiveSummaryState =
      statusChangeForLive === undefined
        ? foldedLiveSummary
        : applySessionLiveSummaryStatus(foldedLiveSummary, statusChangeForLive.value);
    const currentLiveSummaryChanged = sessionLiveSummaryChanged(
      priorLiveSummary,
      currentLiveSummaryState
    );
    if (currentLiveSummaryChanged) {
      writeIngestMetaValue(this.db, 'liveSummaryState', JSON.stringify(currentLiveSummaryState));
    }
    const lastPersistedLiveSummary = readLiveSummaryPersisted(this.db);
    const currentLiveSummary = currentLiveSummaryState;
    const liveSummaryVisibleChanged = sessionLiveSummaryChanged(
      lastPersistedLiveSummary ?? EMPTY_SESSION_LIVE_SUMMARY_STATE,
      currentLiveSummary
    );
    const liveSummaryFailureChanged =
      (lastPersistedLiveSummary?.failure?.kind ?? null) !==
      (currentLiveSummary.failure?.kind ?? null);
    const liveSummaryDecision = decideLiveSummaryPersist({
      nowMs: nowMsLive,
      statusTransition: statusChangeForLive !== undefined,
      failureChanged: liveSummaryFailureChanged,
      lastPersistedAtMs: readIngestMetaNumber(this.db, 'lastLiveSummaryPersistedAtMs'),
    });

    // Only read the stored cost total when the cost-persist window is open (KB-3).
    // Window needs no cost value: idle forces (D17), else assistant upsert + 30s throttle.
    const nowMs = Date.now();
    const lastCostPersistedAtMs = readIngestMetaNumber(this.db, 'lastCostPersistedAtMs');
    const costWindowOpen =
      idleTransition ||
      (wroteAssistantMessageItem &&
        (lastCostPersistedAtMs === null ||
          nowMs - lastCostPersistedAtMs >= COST_PERSIST_THROTTLE_MS));

    // The running cost is committed with the rows, so a persist reads a stored total instead
    // of the session's message history. A session without one — created before the total
    // existed, or a clone destination — seeds it from its stored rows once.
    let runningCostUsd = readIngestMetaNumber(this.db, RUNNING_ASSISTANT_COST_META_KEY);
    if (runningCostUsd === null && costWindowOpen) {
      const messageRows = this.db
        .select({ item_data: ingestItems.item_data })
        .from(ingestItems)
        .where(and(eq(ingestItems.item_type, 'message'), isNull(ingestItems.item_data_r2_key)))
        .all();
      runningCostUsd = computeRunningAssistantCostUsd(messageRows);
      writeIngestMetaNumber(this.db, RUNNING_ASSISTANT_COST_META_KEY, runningCostUsd);
    }

    const currentCostMicrodollars =
      costWindowOpen && runningCostUsd !== null
        ? runningAssistantCostMicrodollars(runningCostUsd)
        : null;

    const lastActivityValueMs = ingestedAt ?? nowMs;
    const decision = decideLivePersist({
      nowMs,
      wroteActivityItem,
      wroteAssistantMessageItem,
      idleTransition,
      lastActivityValueMs,
      lastActivityPersistedAtMs: readIngestMetaNumber(this.db, 'lastActivityPersistedAtMs'),
      lastActivityPersistedValueMs: readIngestMetaNumber(this.db, 'lastActivityPersistedValueMs'),
      currentCostMicrodollars,
      lastCostPersistedAtMs,
      lastCostPersistedMicrodollars: readIngestMetaNumber(this.db, 'lastCostPersistedMicrodollars'),
    });

    const briefingResponseChanged = storedItems.some(
      item =>
        (item.type === 'message' && completedBriefingResponse(item.data) !== undefined) ||
        (item.type === 'part' && isFinalizedBriefingText(item.data))
    );
    if (decision.persistActivity || decision.persistCost || briefingResponseChanged) {
      const columns: {
        costMicrodollars?: number;
        lastActivityAtIso?: string;
        liveSummary?: { summary: SessionLiveSummary; atIso: string };
        briefingExcerpt?: { excerpt: BriefingExcerpt; receivedAtIso: string };
      } = {};
      if (decision.persistCost && currentCostMicrodollars !== null) {
        columns.costMicrodollars = currentCostMicrodollars;
      }
      if (decision.persistActivity) {
        columns.lastActivityAtIso = new Date(lastActivityValueMs).toISOString();
      }
      // The live summary rides the activity write: a summary change with no
      // activity (a metadata-only or lifecycle-only batch) must not open a
      // persist of its own, and the next activity carries the newer summary.
      if (decision.persistActivity && liveSummaryDecision) {
        columns.liveSummary = {
          summary: currentLiveSummary,
          atIso: new Date(lastActivityValueMs).toISOString(),
        };
      }
      const costToPersist = columns.costMicrodollars;
      const activityValueMs = decision.persistActivity ? lastActivityValueMs : undefined;
      const summaryToPersist = columns.liveSummary;
      const connectionString = this.env.HYPERDRIVE.connectionString;
      this.ctx.waitUntil(
        (async () => {
          try {
            if (briefingResponseChanged) {
              try {
                const excerpt = this.latestBriefingExcerpt(storedItems);
                if (excerpt) {
                  columns.briefingExcerpt = {
                    excerpt,
                    receivedAtIso: new Date(ingestedAt ?? nowMsLive).toISOString(),
                  };
                }
              } catch (error) {
                console.error('SessionIngestDO failed to read completed briefing response', {
                  kiloUserId,
                  sessionId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            if (this.isDeleted()) return;
            await persistLiveSessionColumns(connectionString, kiloUserId, sessionId, columns);
            if (this.isDeleted()) return;
            if (summaryToPersist !== undefined) {
              const prevSummaryAt = readIngestMetaNumber(this.db, 'lastLiveSummaryPersistedAtMs');
              if (prevSummaryAt === null || nowMsLive > prevSummaryAt) {
                writeIngestMetaNumber(this.db, 'lastLiveSummaryPersistedAtMs', nowMsLive);
                if (liveSummaryVisibleChanged) {
                  writeIngestMetaValue(
                    this.db,
                    'lastLiveSummaryPersisted',
                    JSON.stringify(summaryToPersist.summary)
                  );
                }
              }
            }
            // Max-merge post-await so out-of-order concurrent ingests cannot regress throttle meta.
            if (activityValueMs !== undefined) {
              const prevAt = readIngestMetaNumber(this.db, 'lastActivityPersistedAtMs');
              if (prevAt === null || nowMs > prevAt) {
                writeIngestMetaNumber(this.db, 'lastActivityPersistedAtMs', nowMs);
              }
              const prevPersistedValue = readIngestMetaNumber(
                this.db,
                'lastActivityPersistedValueMs'
              );
              if (prevPersistedValue === null || activityValueMs > prevPersistedValue) {
                writeIngestMetaNumber(this.db, 'lastActivityPersistedValueMs', activityValueMs);
              }
              const prevActivityValue = readIngestMetaNumber(this.db, 'lastActivityValueMs');
              if (prevActivityValue === null || activityValueMs > prevActivityValue) {
                writeIngestMetaNumber(this.db, 'lastActivityValueMs', activityValueMs);
              }
            }
            if (costToPersist !== undefined) {
              const prevCostAt = readIngestMetaNumber(this.db, 'lastCostPersistedAtMs');
              if (prevCostAt === null || nowMs > prevCostAt) {
                writeIngestMetaNumber(this.db, 'lastCostPersistedAtMs', nowMs);
              }
              const prevCost = readIngestMetaNumber(this.db, 'lastCostPersistedMicrodollars');
              if (prevCost === null || costToPersist > prevCost) {
                writeIngestMetaNumber(this.db, 'lastCostPersistedMicrodollars', costToPersist);
              }
            }
            // The card reads the persisted row, so refresh only after the write
            // landed and only when a card follows this session: the follow gate
            // saves the whole snapshot build for a session nobody watches.
            if (summaryToPersist !== undefined && liveSummaryVisibleChanged) {
              try {
                await refreshGlanceableSessions(this.env, {
                  userId: kiloUserId,
                  cliSessionIds: [sessionId],
                  cardFollowSessionIds: [sessionId],
                });
              } catch (refreshError) {
                console.error('SessionIngestDO failed to refresh the session card', {
                  kiloUserId,
                  sessionId,
                  error:
                    refreshError instanceof Error ? refreshError.message : String(refreshError),
                });
              }
            }
          } catch (error) {
            console.error('SessionIngestDO failed to persist live session columns', {
              kiloUserId,
              sessionId,
              error: error instanceof Error ? error.message : String(error),
              stack: error instanceof Error ? error.stack : undefined,
            });
          }
        })()
      );
    }

    const attentionSignals: AttentionSignal[] = [];

    const statusChange = statusChangeForLive;
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
        attentionKind: attentionKindForNeedsInputStatus(statusChange.value),
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

  /**
   * Clear a stored attention status when the owning CLI disconnects.
   * Metadata owner entry point — UserConnectionDO has no Postgres write path.
   * Attention check and conditional write live in `resetAttentionStatusOnCliDisconnect`.
   */
  async resetAttentionStatusOnCliDisconnect(kiloUserId: string, sessionId: string): Promise<void> {
    await resetAttentionStatusOnCliDisconnect(this.env, kiloUserId, sessionId, this.ctx);
  }

  private latestBriefingExcerpt(items: IngestBatch): BriefingExcerpt | undefined {
    const messageIds = new Set<string>();
    for (const item of items) {
      if (item.type === 'message' && completedBriefingResponse(item.data)) {
        messageIds.add(item.data.id);
      } else if (item.type === 'part' && isFinalizedBriefingText(item.data)) {
        messageIds.add(item.data.messageID);
      }
      if (messageIds.size > BRIEFING_MAX_EXCERPT_SOURCE_ROWS) return undefined;
    }
    const encoder = new TextEncoder();
    let latestMessage: unknown;
    let latestMessageId = '';
    let latestCompletedAt = -Infinity;
    let messageBytes = 0;
    for (const messageId of messageIds) {
      const row = this.db
        .select({
          item_data: ingestItems.item_data,
          item_data_r2_key: ingestItems.item_data_r2_key,
        })
        .from(ingestItems)
        .where(
          and(
            eq(ingestItems.item_id, `message/${messageId}`),
            isNull(ingestItems.item_data_r2_key),
            sql`length(${ingestItems.item_data}) <= ${BRIEFING_MAX_INLINE_BYTES}`
          )
        )
        .get();
      if (!row || row.item_data_r2_key || row.item_data.length > BRIEFING_MAX_INLINE_BYTES)
        continue;
      const bytes = encoder.encode(row.item_data).byteLength;
      if (bytes > BRIEFING_MAX_INLINE_BYTES) continue;
      const message = completedBriefingResponse(JSON.parse(row.item_data));
      if (
        message &&
        (message.time.completed > latestCompletedAt ||
          (message.time.completed === latestCompletedAt && message.id > latestMessageId))
      ) {
        latestMessage = message;
        latestMessageId = message.id;
        latestCompletedAt = message.time.completed;
        messageBytes = bytes;
      }
    }
    if (latestMessage === undefined) return undefined;
    let fetchedRows = 0;
    let inlineBytes = messageBytes;
    const parts: unknown[] = [];
    for (const row of streamMessagePartRows<PartExportRow & { oversized_inline: number }>({
      messageId: latestMessageId,
      order: 'row-id',
      batchSize: BRIEFING_MAX_EXCERPT_SOURCE_ROWS + 1,
      fetchPage: (range, after, limit) => {
        const remaining = BRIEFING_MAX_EXCERPT_SOURCE_ROWS + 1 - fetchedRows;
        if (remaining <= 0) return [];
        const rows = this.db
          .select({
            id: ingestItems.id,
            ingested_at: ingestItems.ingested_at,
            item_id: ingestItems.item_id,
            item_data: sql<string>`CASE
              WHEN ${ingestItems.item_data_r2_key} IS NOT NULL
                OR length(${ingestItems.item_data}) > ${BRIEFING_MAX_INLINE_BYTES} THEN ''
              WHEN json_extract(${ingestItems.item_data}, '$.type') = 'text'
                THEN ${ingestItems.item_data}
              ELSE ''
            END`,
            item_data_r2_key: ingestItems.item_data_r2_key,
            oversized_inline: sql<number>`CASE
              WHEN ${ingestItems.item_data_r2_key} IS NULL
                AND length(${ingestItems.item_data}) > ${BRIEFING_MAX_INLINE_BYTES}
                THEN json_extract(${ingestItems.item_data}, '$.type') = 'text'
              ELSE 0
            END`,
          })
          .from(ingestItems)
          .where(
            and(
              eq(ingestItems.item_type, 'part'),
              gte(ingestItems.item_id, range.start),
              lt(ingestItems.item_id, range.end),
              after ? gt(ingestItems.id, after.id) : undefined
            )
          )
          .orderBy(ingestItems.id)
          .limit(Math.min(limit, remaining))
          .all();
        fetchedRows += rows.length;
        return rows;
      },
    })) {
      if (fetchedRows > BRIEFING_MAX_EXCERPT_SOURCE_ROWS || row.oversized_inline === 1) {
        return undefined;
      }
      if (row.item_data_r2_key || !row.item_data) continue;
      if (row.item_data.length > BRIEFING_MAX_INLINE_BYTES) return undefined;
      inlineBytes += encoder.encode(row.item_data).byteLength;
      if (inlineBytes > BRIEFING_MAX_INLINE_BYTES) return undefined;
      parts.push(JSON.parse(row.item_data));
    }
    return buildBriefingExcerpt(latestMessage, parts);
  }

  /** Builds a text excerpt for a completed assistant message from its already-ingested text parts. */
  private buildAssistantExcerptForMessage(messageId: string): string {
    const itemDataRows: string[] = [];
    for (const row of streamMessagePartRows<PartExcerptRow>({
      messageId,
      order: 'ingest',
      batchSize: EXCERPT_PART_BATCH_SIZE,
      fetchPage: (range, after, limit) =>
        this.db
          .select({
            id: ingestItems.id,
            ingested_at: ingestItems.ingested_at,
            item_id: ingestItems.item_id,
            item_data: ingestItems.item_data,
          })
          .from(ingestItems)
          .where(
            and(
              eq(ingestItems.item_type, 'part'),
              gte(ingestItems.item_id, range.start),
              lt(ingestItems.item_id, range.end),
              isNull(ingestItems.item_data_r2_key),
              after
                ? afterIngestOrderCursor({ ingestedAt: after.ingested_at, id: after.id })
                : undefined
            )
          )
          .orderBy(ingestItems.ingested_at, ingestItems.id)
          .limit(limit)
          .all(),
    })) {
      itemDataRows.push(row.item_data);
    }

    // Parts offloaded to R2 (oversized items) store '{}' inline; skip them rather
    // than fetching from R2 — this is a best-effort excerpt, not a full transcript.
    return buildAssistantExcerpt(itemDataRows);
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

  async readSessionDiff(): Promise<SessionDiffRead> {
    return readSessionDiff(this.db, this.env.SESSION_INGEST_R2);
  }

  /**
   * Stream the session export. With `upToMessageId`, keep only messages inside
   * the inclusive cut (see `isItemWithinMessageCut`) and emit an empty
   * `sessionDiff`; without it the output is the full export.
   */
  async getAllStream(upToMessageId?: string): Promise<ReadableStream<Uint8Array>> {
    return this.buildSessionExportStream({ upToMessageId });
  }

  /** Include later messages using the same session-info projection as snapshot shares. */
  async getLiveSharedSessionStream(): Promise<ReadableStream<Uint8Array>> {
    const snapshot = await readKiloSdkSessionSnapshot(this.db, this.env.SESSION_INGEST_R2);
    // Session details are optional for reading an existing transcript.
    const shareInfo = snapshot.kind === 'value' ? projectSharedSessionInfo(snapshot.info) : '{}';
    return this.buildSessionExportStream({ includeSessionDiff: false, shareInfo });
  }

  /**
   * Freeze the session info a public share exposes. Snapshots are keyed by the
   * public generation so a later share cannot replace an earlier snapshot while
   * its capability is still valid. Snapshot retention matches the link lifetime.
   */
  async captureShareInfo(publicId: string, duration: SessionShareDuration = '7d'): Promise<number> {
    const shareDuration = sessionShareDurationSchema.parse(duration);
    if (this.isDeleted()) throw new Error('Session deleted');
    const snapshot = await readKiloSdkSessionSnapshot(this.db, this.env.SESSION_INGEST_R2);
    if (snapshot.kind === 'too_large') throw new Error(SHARE_INFO_TOO_LARGE_ERROR);
    if (snapshot.kind !== 'value' && snapshot.kind !== 'pending') {
      throw new Error('Share snapshot is unavailable');
    }
    if (this.isDeleted()) throw new Error('Session deleted');
    const info = snapshot.kind === 'value' ? projectSharedSessionInfo(snapshot.info) : '{}';
    const now = Date.now();
    const expiresAtSeconds = getSessionShareExpiresAt(shareDuration, Math.floor(now / 1000));
    const expiresAt = expiresAtSeconds === null ? null : expiresAtSeconds * 1000;
    const value = JSON.stringify({ capturedAt: now, expiresAt, info });
    if (new TextEncoder().encode(value).byteLength > MAX_INGEST_ITEM_BYTES) {
      throw new Error(SHARE_INFO_TOO_LARGE_ERROR);
    }

    this.db
      .insert(ingestMeta)
      .values({ key: shareInfoKey(publicId), value })
      .onConflictDoUpdate({ target: ingestMeta.key, set: { value } })
      .run();
    this.pruneShareInfo(now);
    return now;
  }

  async deleteShareInfo(publicId: string): Promise<void> {
    this.db
      .delete(ingestMeta)
      .where(eq(ingestMeta.key, shareInfoKey(publicId)))
      .run();
  }

  private pruneShareInfo(now: number): void {
    const rows = this.db
      .select({ key: ingestMeta.key, value: ingestMeta.value })
      .from(ingestMeta)
      .where(like(ingestMeta.key, `${SHARE_INFO_KEY_PREFIX}%`))
      .all();
    for (const row of rows) {
      if (readShareInfo(row.value, now) === null) {
        this.db.delete(ingestMeta).where(eq(ingestMeta.key, row.key)).run();
      }
    }
  }

  /**
   * Stream the frozen boundary of a public share. Only items persisted strictly
   * before `ingestedBeforeMs` are included, the session info is the snapshot
   * captured when the share was created, and the cumulative whole-session diff
   * is never exposed. Message-summary diffs remain part of the transcript so
   * `kilo import` can still restore intentional file changes.
   */
  async getSharedSessionStream(params: {
    publicId: string;
    ingestedBeforeMs: number;
  }): Promise<ReadableStream<Uint8Array>> {
    return this.buildSessionExportStream({
      ingestedBeforeMs: params.ingestedBeforeMs,
      includeSessionDiff: false,
      shareInfo: this.readShareInfo(params.publicId),
    });
  }

  private readShareInfo(publicId: string): string | null {
    const row = this.db
      .select({ value: ingestMeta.value })
      .from(ingestMeta)
      .where(eq(ingestMeta.key, shareInfoKey(publicId)))
      .get();
    return readShareInfo(row?.value ?? null, Date.now());
  }

  private buildSessionExportStream(options: {
    upToMessageId?: string;
    ingestedBeforeMs?: number;
    includeSessionDiff?: boolean;
    shareInfo?: string | null;
  }): ReadableStream<Uint8Array> {
    const db = this.db;
    const r2 = this.env.SESSION_INGEST_R2;
    const encoder = new TextEncoder();
    const upToMessageId = options.upToMessageId;
    const ingestedBeforeCondition =
      options.ingestedBeforeMs === undefined
        ? undefined
        : lt(ingestItems.ingested_at, options.ingestedBeforeMs);

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode('{"info":'));
          if (options.shareInfo !== undefined) {
            controller.enqueue(encoder.encode(options.shareInfo ?? '{}'));
          } else {
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
          }

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
                  ingestedBeforeCondition,
                  msgCursor ? afterIngestOrderCursor(msgCursor) : undefined
                )
              )
              .orderBy(ingestItems.ingested_at, ingestItems.id)
              .limit(CURSOR_BATCH)
              .all();

            if (msgBatch.length === 0) break;
            msgCursor = ingestOrderCursor(msgBatch[msgBatch.length - 1]);

            for (const msgRow of msgBatch) {
              if (
                upToMessageId !== undefined &&
                !isItemWithinMessageCut(
                  { itemType: 'message', itemId: msgRow.item_id },
                  upToMessageId
                )
              ) {
                continue;
              }
              if (!firstMsg) controller.enqueue(encoder.encode(','));
              firstMsg = false;

              controller.enqueue(encoder.encode('{"info":'));
              await enqueueItemData(controller, msgRow, r2, encoder);

              // parts for this message: `part/{msgId}/{partId}`, and `{msgId}/{partId}` for rows
              // in the older layout
              const msgId = msgRow.item_id.slice('message/'.length);
              controller.enqueue(encoder.encode(',"parts":['));
              let firstPart = true;

              for (const partRow of streamMessagePartRows<PartExportRow>({
                messageId: msgId,
                order: 'ingest',
                batchSize: CURSOR_BATCH,
                fetchPage: (range, after, limit) =>
                  db
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
                        eq(ingestItems.item_type, 'part'),
                        gte(ingestItems.item_id, range.start),
                        lt(ingestItems.item_id, range.end),
                        ingestedBeforeCondition,
                        after
                          ? afterIngestOrderCursor({
                              ingestedAt: after.ingested_at,
                              id: after.id,
                            })
                          : undefined
                      )
                    )
                    .orderBy(ingestItems.ingested_at, ingestItems.id)
                    .limit(limit)
                    .all(),
              })) {
                if (!firstPart) controller.enqueue(encoder.encode(','));
                firstPart = false;

                await enqueueItemData(controller, partRow, r2, encoder);
              }

              controller.enqueue(encoder.encode(']}'));
            }
          }

          controller.enqueue(encoder.encode(']'));
          controller.enqueue(encoder.encode(',"sessionDiff":'));
          const diffRow =
            upToMessageId === undefined && options.includeSessionDiff !== false
              ? db
                  .select({
                    item_data: ingestItems.item_data,
                    item_data_r2_key: ingestItems.item_data_r2_key,
                  })
                  .from(ingestItems)
                  .where(and(eq(ingestItems.item_type, 'session_diff'), ingestedBeforeCondition))
                  .limit(1)
                  .get()
              : undefined;
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

    // Best-effort persist the per-session total cost to Postgres so the session
    // list can surface it. Runs before the O11Y RPC so an analytics failure cannot
    // skip it. Failures are logged and swallowed — must never break metrics emission.
    // Same helper + CASE guard as live cost persist (D20).
    try {
      if (Number.isFinite(metrics.totalCost)) {
        const totalCostMicrodollars = Math.max(0, Math.round(metrics.totalCost * 1_000_000));
        await persistLiveSessionColumns(
          this.env.HYPERDRIVE.connectionString,
          kiloUserId,
          sessionId,
          { costMicrodollars: totalCostMicrodollars }
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

    if (this.isDeleted()) return false;
    await this.env.O11Y.ingestSessionMetrics({
      kiloUserId,
      sessionId,
      ingestVersion,
      model,
      ...metrics,
    });

    if (this.isDeleted()) return false;
    this.db
      .insert(ingestMeta)
      .values({ key: 'metricsEmitted', value: 'true' })
      .onConflictDoUpdate({ target: ingestMeta.key, set: { value: 'true' } })
      .run();

    return true;
  }

  private async scheduleAlarm(metricsAlarmAt?: number): Promise<void> {
    if (metricsAlarmAt !== undefined) {
      writeIngestMetaNumber(this.db, 'metricsAlarmAt', metricsAlarmAt);
    }
    const dueAt = metricsAlarmAt ?? readIngestMetaNumber(this.db, 'metricsAlarmAt');
    if (dueAt === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(dueAt);
  }

  /** Emits session metrics after close drain or inactivity, once per turn. */
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
        ])
      )
      .all();

    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));

    if (meta['deleted'] === 'true') return;

    const kiloUserId = meta['kiloUserId'];
    const sessionId = meta['sessionId'];

    if (!kiloUserId || !sessionId) return;

    const metricsAlarmAt = readIngestMetaValue(this.db, 'metricsAlarmAt');
    const metricsDue =
      metricsAlarmAt !== null
        ? Number(metricsAlarmAt) <= Date.now()
        : meta['metricsEmitted'] !== 'true';
    if (!metricsDue) {
      await this.scheduleAlarm();
      return;
    }

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

    if (this.isDeleted()) return;
    // A lifecycle event that interleaved with emission armed a newer metrics time; keep it.
    if (
      metricsAlarmAt !== null &&
      readIngestMetaValue(this.db, 'metricsAlarmAt') === metricsAlarmAt
    ) {
      this.db.delete(ingestMeta).where(eq(ingestMeta.key, 'metricsAlarmAt')).run();
    }
    await this.scheduleAlarm();
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

  isDeleted(): boolean {
    return (
      this.db
        .select({ value: ingestMeta.value })
        .from(ingestMeta)
        .where(eq(ingestMeta.key, 'deleted'))
        .get()?.value === 'true'
    );
  }

  async stageR2Object(
    params: { kiloUserId: string; sessionId: string; key: string },
    body: ReadableStream<unknown> | Uint8Array
  ): Promise<boolean> {
    const result = await this.stageR2ObjectInternal(params, body);
    if (result === 'too_large') throw new Error('Unbounded staging returned a byte-limit result');
    return result;
  }
  async stageBoundedR2Object(
    params: { kiloUserId: string; sessionId: string; key: string },
    body: ReadableStream<unknown> | Uint8Array,
    maxBytes: number
  ): Promise<boolean | 'too_large'> {
    return this.stageR2ObjectInternal(params, body, maxBytes);
  }

  private async stageR2ObjectInternal(
    params: { kiloUserId: string; sessionId: string; key: string },
    body: ReadableStream<unknown> | Uint8Array,
    maxBytes?: number
  ): Promise<boolean | 'too_large'> {
    const cancelBody = async (): Promise<void> => {
      if (body instanceof ReadableStream) await body.cancel();
    };
    sessionIdSchema.parse(params.sessionId);
    const doKey = `${params.kiloUserId}/${params.sessionId}`;
    if (
      (this.ctx.id.name && this.ctx.id.name !== doKey) ||
      !['ingest', 'items'].some(prefix => params.key.startsWith(`${prefix}/${doKey}/`))
    ) {
      throw new Error('Session R2 identity conflict');
    }
    if (maxBytes !== undefined && body instanceof Uint8Array && body.byteLength > maxBytes) {
      return 'too_large';
    }
    if (this.isDeleted()) {
      await cancelBody();
      return false;
    }
    writeIngestMetaIfChanged(this.db, { key: 'kiloUserId', incomingValue: params.kiloUserId });
    writeIngestMetaIfChanged(this.db, { key: 'sessionId', incomingValue: params.sessionId });
    const pendingKey = `pendingR2/${params.key}`;
    this.db
      .insert(ingestMeta)
      .values({ key: pendingKey, value: params.key })
      .onConflictDoUpdate({ target: ingestMeta.key, set: { value: params.key } })
      .run();
    const operation = (async (): Promise<boolean | 'too_large'> => {
      const reservation = await this.env.SESSION_INGEST_R2.put(params.key, crypto.randomUUID(), {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
      });
      const etag = reservation?.etag ?? (await this.env.SESSION_INGEST_R2.head(params.key))?.etag;
      if (this.isDeleted()) {
        await cancelBody();
        await this.env.SESSION_INGEST_R2.delete(params.key);
        this.db.delete(ingestMeta).where(eq(ingestMeta.key, pendingKey)).run();
        return false;
      }
      if (!etag) throw new Error('Session R2 reservation disappeared');

      let written: R2Object | null;
      if (maxBytes === undefined) {
        written = await this.env.SESSION_INGEST_R2.put(params.key, body, {
          onlyIf: { etagMatches: etag },
        });
      } else if (body instanceof Uint8Array) {
        written = await this.env.SESSION_INGEST_R2.put(params.key, body, {
          onlyIf: { etagMatches: etag },
        });
      } else {
        const result = await this.writeBoundedMultipart(params.key, body, maxBytes, etag);
        if (result === 'too_large') {
          await this.env.SESSION_INGEST_R2.delete(params.key);
          this.db.delete(ingestMeta).where(eq(ingestMeta.key, pendingKey)).run();
          return result;
        }
        written = result;
      }
      const deleted = this.isDeleted();
      if (!written && !deleted) throw new Error('Session R2 reservation changed');
      if (deleted) await this.env.SESSION_INGEST_R2.delete(params.key);
      this.db.delete(ingestMeta).where(eq(ingestMeta.key, pendingKey)).run();
      return !deleted;
    })();
    this.activeR2Writes.add(operation);
    return operation.finally(() => this.activeR2Writes.delete(operation));
  }

  private async writeBoundedMultipart(
    key: string,
    body: ReadableStream<unknown>,
    maxBytes: number,
    reservationEtag: string
  ): Promise<R2Object | null | 'too_large'> {
    const partSize = 5 * 1024 * 1024;
    const reader = body.getReader();
    let buffer = new Uint8Array(partSize);
    let buffered = 0;
    let total = 0;
    let upload: R2MultipartUpload | undefined;
    const uploadedParts: R2UploadedPart[] = [];
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) {
          throw new TypeError('Staging stream yielded a non-byte chunk');
        }
        total += result.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel('ingest body exceeded the staging byte budget').catch(() => {});
          await upload?.abort().catch(() => {});
          return 'too_large';
        }
        let offset = 0;
        while (offset < result.value.byteLength) {
          const count = Math.min(partSize - buffered, result.value.byteLength - offset);
          buffer.set(result.value.subarray(offset, offset + count), buffered);
          buffered += count;
          offset += count;
          if (buffered === partSize) {
            upload ??= await this.env.SESSION_INGEST_R2.createMultipartUpload(key);
            uploadedParts.push(await upload.uploadPart(uploadedParts.length + 1, buffer));
            buffer = new Uint8Array(partSize);
            buffered = 0;
          }
        }
      }

      if (!upload) {
        return this.env.SESSION_INGEST_R2.put(key, buffer.subarray(0, buffered), {
          onlyIf: { etagMatches: reservationEtag },
        });
      }
      if (buffered > 0) {
        uploadedParts.push(
          await upload.uploadPart(uploadedParts.length + 1, buffer.subarray(0, buffered))
        );
      }
      if (this.isDeleted()) {
        await upload.abort();
        return null;
      }
      const current = await this.env.SESSION_INGEST_R2.head(key);
      if (current?.etag !== reservationEtag) {
        await upload.abort();
        return null;
      }
      return await upload.complete(uploadedParts);
    } catch (error) {
      await upload?.abort().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  async clearForWorktree(kiloUserId: string, sessionId: string): Promise<void> {
    sessionIdSchema.parse(sessionId);
    const doKey = `${kiloUserId}/${sessionId}`;
    if (this.ctx.id.name && this.ctx.id.name !== doKey)
      throw new Error('Session identity conflict');
    await this.clearSessionData({ kiloUserId, sessionId });
  }

  async clear(): Promise<void> {
    const meta = this.db
      .select()
      .from(ingestMeta)
      .where(inArray(ingestMeta.key, ['kiloUserId', 'sessionId']))
      .all();
    const kiloUserId = meta.find(row => row.key === 'kiloUserId')?.value;
    const sessionId = meta.find(row => row.key === 'sessionId')?.value;
    await this.clearSessionData(kiloUserId && sessionId ? { kiloUserId, sessionId } : undefined);
  }

  private async clearSessionData(identity?: {
    kiloUserId: string;
    sessionId: string;
  }): Promise<void> {
    this.db
      .insert(ingestMeta)
      .values({ key: 'deleted', value: 'true' })
      .onConflictDoUpdate({ target: ingestMeta.key, set: { value: 'true' } })
      .run();
    if (!this.cleanupOperation) {
      this.cleanupOperation = this.clearFencedSessionData(identity).finally(() => {
        this.cleanupOperation = undefined;
      });
    }
    await this.cleanupOperation;
  }

  private async clearFencedSessionData(identity?: {
    kiloUserId: string;
    sessionId: string;
  }): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await Promise.allSettled([...this.activeR2Writes]);
    const keys = new Set(
      this.db
        .select({ item_data_r2_key: ingestItems.item_data_r2_key })
        .from(ingestItems)
        .where(isNotNull(ingestItems.item_data_r2_key))
        .all()
        .flatMap(row => (row.item_data_r2_key ? [row.item_data_r2_key] : []))
    );
    for (const row of this.db.select().from(ingestMeta).all()) {
      if (row.key.startsWith('pendingR2/') && row.value) keys.add(row.value);
    }
    const knownKeys = [...keys];
    for (let offset = 0; offset < knownKeys.length; offset += 1000) {
      await this.env.SESSION_INGEST_R2.delete(knownKeys.slice(offset, offset + 1000));
    }
    if (identity) {
      for (const namespace of ['ingest', 'items']) {
        const prefix = `${namespace}/${identity.kiloUserId}/${identity.sessionId}/`;
        let cursor: string | undefined;
        do {
          const page = await this.env.SESSION_INGEST_R2.list({ prefix, cursor, limit: 1000 });
          if (page.objects.length > 0)
            await this.env.SESSION_INGEST_R2.delete(page.objects.map(object => object.key));
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
    }
    this.ctx.storage.transactionSync(() => {
      this.db.delete(ingestItems).run();
      this.db.delete(agentNotificationDispatch).run();
      this.db.delete(ingestMeta).where(ne(ingestMeta.key, 'deleted')).run();
    });
    await this.ctx.storage.deleteAlarm();
  }

  private async wipeStorage(): Promise<void> {
    // Capture the R2 keys first (synchronous SQLite). The SQLite wipe below must
    // never be separated from this key read by an R2 await: an R2 await opens the
    // Durable Object input gate, so a same-destination stageCloneBatch could commit
    // rows and clone meta, then the reset would delete that commit.
    const r2Rows = this.db
      .select({ item_data_r2_key: ingestItems.item_data_r2_key })
      .from(ingestItems)
      .where(isNotNull(ingestItems.item_data_r2_key))
      .all();
    const r2Keys = r2Rows.map(r => r.item_data_r2_key).filter((k): k is string => k !== null);

    await this.ctx.storage.deleteAlarm();
    if (this.isDeleted()) throw new Error('Session deleted');
    this.ctx.storage.transactionSync(() => {
      this.db.delete(ingestItems).run();
      this.db.delete(agentNotificationDispatch).run();
      this.db.delete(ingestMeta).run();
    });

    // Delete the captured R2 objects last, after the SQLite wipe is complete.
    if (r2Keys.length > 0) {
      try {
        await this.env.SESSION_INGEST_R2.delete(r2Keys);
      } catch (error) {
        console.error('Failed to delete wiped session ingest R2 bodies', {
          count: r2Keys.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Read the next bounded batch of clone-eligible ingest rows in (ingested_at, id)
   * order after `cursor`. Returns the rows, the next cursor (null when done), a
   * `done` flag, and a stable SHA-256 digest over the returned rows. R2 bodies are
   * not read here; the digest covers the stored reference (item_data or r2 key).
   */
  async exportCloneBatch(
    cursor: IngestOrderCursor | null,
    limit: number
  ): Promise<ExportCloneBatchResult> {
    const rows = this.db
      .select({
        id: ingestItems.id,
        item_id: ingestItems.item_id,
        item_type: ingestItems.item_type,
        item_data: ingestItems.item_data,
        item_data_r2_key: ingestItems.item_data_r2_key,
        ingested_at: ingestItems.ingested_at,
      })
      .from(ingestItems)
      .where(
        and(
          inArray(ingestItems.item_type, CLONE_ITEM_TYPES),
          cursor ? afterIngestOrderCursor(cursor) : undefined
        )
      )
      .orderBy(ingestItems.ingested_at, ingestItems.id)
      .limit(limit)
      .all();

    const batchRows: CloneBatchRow[] = rows.map(row => ({
      itemId: row.item_id,
      itemType: row.item_type as CloneItemType,
      itemData: row.item_data,
      itemDataR2Key: row.item_data_r2_key,
      ingestedAt: row.ingested_at,
    }));

    const digest = await computeCloneBatchDigest(batchRows);
    const done = rows.length < limit;
    const nextCursor = done ? null : ingestOrderCursor(rows[rows.length - 1]);

    return { rows: batchRows, nextCursor, done, digest };
  }

  /** True when this session holds a `message` row with exactly this message ID. */
  hasMessageItem(messageId: string): boolean {
    const row = this.db
      .select({ id: ingestItems.id })
      .from(ingestItems)
      .where(
        and(eq(ingestItems.item_type, 'message'), eq(ingestItems.item_id, `message/${messageId}`))
      )
      .get();
    return row !== undefined;
  }

  private readCloneStage(): CloneStageState {
    const completeSource = readCloneMeta(this.db, 'cloneCompleteSourceId');
    const upToMessageId = readCloneMeta(this.db, 'cloneUpToMessageId');
    if (completeSource !== null) {
      return {
        kind: 'complete',
        sourceSessionId: completeSource,
        destinationSessionId: readCloneMeta(this.db, 'cloneDestinationSessionId') ?? '',
        upToMessageId,
      };
    }

    const source = readCloneMeta(this.db, 'cloneSourceSessionId');
    const destination = readCloneMeta(this.db, 'cloneDestinationSessionId');
    if (source !== null && destination !== null) {
      const nextCursorRaw = readCloneMeta(this.db, 'cloneNextCursor');
      let nextCursor: IngestOrderCursor | null = null;
      if (nextCursorRaw !== null) {
        try {
          nextCursor = JSON.parse(nextCursorRaw) as IngestOrderCursor;
        } catch {
          nextCursor = null;
        }
      }
      return {
        kind: 'in_progress',
        sourceSessionId: source,
        destinationSessionId: destination,
        upToMessageId,
        nextCursor,
        rollingDigest: readCloneMeta(this.db, 'cloneRollingDigest') ?? '',
        copiedItemCount: Number(readCloneMeta(this.db, 'cloneCopiedItemCount') ?? '0') || 0,
      };
    }

    return { kind: 'empty' };
  }

  /**
   * Persist one batch of already-rewritten clone rows and advance the clone stage
   * state. Idempotent for the same source: re-staging the same batch upserts the
   * same rows and rewrites the same meta. A different stored source, destination,
   * or message cut is rejected without mutation.
   */
  stageCloneBatch(params: StageCloneBatchParams): StageCloneBatchResult {
    if (this.isDeleted()) throw new Error('Session deleted');
    const stage = this.readCloneStage();

    if (stage.kind === 'complete') {
      if (isSameCloneStage(stage, params)) {
        return {
          status: 'complete',
          sourceSessionId: stage.sourceSessionId,
          destinationSessionId: stage.destinationSessionId,
        };
      }
      return {
        status: 'mismatch',
        storedSourceSessionId: stage.sourceSessionId,
        storedDestinationSessionId: stage.destinationSessionId,
      };
    }

    if (stage.kind === 'in_progress' && !isSameCloneStage(stage, params)) {
      return {
        status: 'mismatch',
        storedSourceSessionId: stage.sourceSessionId,
        storedDestinationSessionId: stage.destinationSessionId,
      };
    }

    for (const row of params.rows) {
      this.db
        .insert(ingestItems)
        .values({
          item_id: row.itemId,
          item_type: row.itemType,
          item_data: row.itemData,
          item_data_r2_key: row.itemDataR2Key,
          ingested_at: row.ingestedAt,
        })
        .onConflictDoUpdate({
          target: ingestItems.item_id,
          set: {
            item_type: row.itemType,
            item_data: row.itemData,
            item_data_r2_key: row.itemDataR2Key,
            ingested_at: row.ingestedAt,
          },
        })
        .run();
    }

    writeCloneMeta(this.db, 'cloneSourceSessionId', params.sourceSessionId);
    writeCloneMeta(this.db, 'cloneDestinationSessionId', params.destinationSessionId);
    // Staged rows are written here, outside the ingest loop, so the running cost no longer
    // describes them: drop it and let the destination seed from its copied rows once.
    this.db.delete(ingestMeta).where(eq(ingestMeta.key, RUNNING_ASSISTANT_COST_META_KEY)).run();
    // Keep "no cut key <=> full clone" true on every write, without relying on
    // resets wiping the whole meta table.
    if (params.upToMessageId !== undefined) {
      writeCloneMeta(this.db, 'cloneUpToMessageId', params.upToMessageId);
    } else {
      this.db.delete(ingestMeta).where(eq(ingestMeta.key, 'cloneUpToMessageId')).run();
    }
    writeCloneMeta(this.db, 'cloneNextCursor', JSON.stringify(params.nextCursor));
    writeCloneMeta(this.db, 'cloneRollingDigest', params.rollingDigest);
    writeCloneMeta(this.db, 'cloneCopiedItemCount', String(params.copiedItemCount));

    return {
      status: 'staged',
      sourceSessionId: params.sourceSessionId,
      destinationSessionId: params.destinationSessionId,
      nextCursor: params.nextCursor,
      rollingDigest: params.rollingDigest,
      copiedItemCount: params.copiedItemCount,
    };
  }

  inspectCloneStage(params: InspectCloneStageParams): InspectCloneStageResult {
    const stage = this.readCloneStage();

    if (stage.kind === 'empty') {
      return { status: 'empty' };
    }

    if (!isSameCloneStage(stage, params)) {
      return {
        status: 'mismatch',
        storedSourceSessionId: stage.sourceSessionId,
        storedDestinationSessionId: stage.destinationSessionId,
        storedStage: stage.kind === 'complete' ? 'complete' : 'in_progress',
      };
    }

    if (stage.kind === 'complete') {
      return {
        status: 'complete',
        sourceSessionId: stage.sourceSessionId,
        destinationSessionId: stage.destinationSessionId,
      };
    }

    return {
      status: 'in_progress',
      sourceSessionId: stage.sourceSessionId,
      destinationSessionId: stage.destinationSessionId,
      nextCursor: stage.nextCursor,
      rollingDigest: stage.rollingDigest,
      copiedItemCount: stage.copiedItemCount,
    };
  }

  finalizeCloneStage(params: FinalizeCloneStageParams): FinalizeCloneStageResult {
    const stage = this.readCloneStage();

    if (stage.kind === 'empty') {
      return { status: 'empty' };
    }

    if (!isSameCloneStage(stage, params)) {
      return {
        status: 'mismatch',
        storedSourceSessionId: stage.sourceSessionId,
        storedDestinationSessionId: stage.destinationSessionId,
      };
    }

    if (stage.kind === 'complete') {
      return {
        status: 'complete',
        sourceSessionId: stage.sourceSessionId,
        destinationSessionId: stage.destinationSessionId,
      };
    }

    if (
      stage.rollingDigest !== params.finalDigest ||
      stage.copiedItemCount !== params.finalItemCount
    ) {
      return {
        status: 'digest_mismatch',
        expectedDigest: params.finalDigest,
        actualDigest: stage.rollingDigest,
        expectedItemCount: params.finalItemCount,
        actualItemCount: stage.copiedItemCount,
      };
    }

    writeCloneMeta(this.db, 'cloneCompleteSourceId', params.sourceSessionId);
    return {
      status: 'complete',
      sourceSessionId: params.sourceSessionId,
      destinationSessionId: params.destinationSessionId,
    };
  }

  /** Delete every staged row, any R2 objects the stage wrote, and the clone state markers. */
  async resetCloneStage(): Promise<void> {
    if (this.isDeleted()) throw new Error('Session deleted');
    await this.wipeStorage();
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
