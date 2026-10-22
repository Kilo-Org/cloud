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
  and,
  or,
  inArray,
  isNull,
  isNotNull,
  like,
  sql,
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
import { getItemIdentity, getPartItemIdentityRange } from '../util/compaction';
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
  computeRunningAssistantCostUsd,
  computeSessionMetrics,
  COST_PERSIST_THROTTLE_MS,
  decideLivePersist,
  INACTIVITY_TIMEOUT_MS,
  POST_CLOSE_DRAIN_MS,
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
  activityEvidence,
  statusEvidence,
  persistBriefingEvidence,
  type BriefingIngestEvent,
} from '../ingest/briefing-evidence';
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

type AlarmMetaKey = 'metricsAlarmAt' | 'briefingEvidenceRetryAt' | 'briefingEvidenceRetryAttempt';

const BRIEFING_EVIDENCE_RETRY_BASE_MS = 30_000;
const BRIEFING_EVIDENCE_RETRY_MAX_MS = 60 * 60_000;

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
  | 'briefingEvidencePending'
  | LiveThrottleMetaKey
  | AlarmMetaKey
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
function stageBriefingEvidence(db: DrizzleSqliteDODatabase, events: BriefingIngestEvent[]): void {
  for (const event of events) {
    writeIngestMetaIfChanged(db, { key: 'briefingEvidencePending', incomingValue: 'true' });
    db.insert(ingestMeta)
      .values({
        key: `briefingEvidence:${event.identity}`,
        value: JSON.stringify(event),
      })
      .onConflictDoNothing()
      .run();
  }
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

function readIngestMetaNumber(
  db: DrizzleSqliteDODatabase,
  key: LiveThrottleMetaKey | AlarmMetaKey
): number | null {
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
  key: LiveThrottleMetaKey | AlarmMetaKey,
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
  }
): Promise<void> {
  const set: {
    total_cost_microdollars?: ReturnType<typeof sql>;
    last_activity_at?: ReturnType<typeof sql>;
    live_summary?: ReturnType<typeof sql>;
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
    // §4.10: in-batch {notificationId -> message} so the post-loop signal builder can
    // re-emit on replay without re-reading item_data from SQLite.
    const pendingAgentNotifications = new Map<string, string>();

    // The items this batch actually stored. The session card summary folds
    // only these: a stale item is an older version of a row the DO already
    // holds a newer one of, and folding it would move the summary back (an
    // old running state of a tool that already finished would revive its step).
    const storedItems: IngestBatch[number][] = [];
    const assistantMessageIds = new Set(
      payload.flatMap(item =>
        item.type === 'message' && item.data.role === 'assistant' ? [item.data.id] : []
      )
    );

    for (const item of payload) {
      const { item_id, item_type } = getItemIdentity(item);
      stageBriefingEvidence(this.db, statusEvidence([item]));

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
      if (
        item.type === 'part' &&
        (item.data.type === 'text' || item.data.type === 'tool') &&
        !assistantMessageIds.has(item.data.messageID)
      ) {
        const parent = this.db
          .select({ item_data: ingestItems.item_data })
          .from(ingestItems)
          .where(eq(ingestItems.item_id, `message/${item.data.messageID}`))
          .get();
        if (typeof parent?.item_data === 'string') {
          const message: unknown = JSON.parse(parent.item_data);
          if (
            typeof message === 'object' &&
            message !== null &&
            'role' in message &&
            message.role === 'assistant'
          ) {
            assistantMessageIds.add(item.data.messageID);
          }
        }
      }
      stageBriefingEvidence(this.db, activityEvidence([item], assistantMessageIds));
      storedItems.push(item);

      if (item.type === 'message' || item.type === 'part') {
        wroteActivityItem = true;
      }
      // Cost gate is assistant-only (computeRunningAssistantCostUsd sums role:assistant).
      // data is looseObject — role is optional at the type level; cheap property check, no parse.
      if (item.type === 'message' && (item.data as { role?: unknown }).role === 'assistant') {
        wroteAssistantMessageItem = true;
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
    // Incoming metadata is committed; only now start the external evidence flush.
    if (readIngestMetaValue(this.db, 'briefingEvidencePending') === 'true') {
      this.ctx.waitUntil(this.flushBriefingEvidence(kiloUserId, sessionId));
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

    // Only scan all inline messages when the cost-persist window is open (KB-3).
    // Window needs no cost value: idle forces (D17), else assistant upsert + 30s throttle.
    const nowMs = Date.now();
    const lastCostPersistedAtMs = readIngestMetaNumber(this.db, 'lastCostPersistedAtMs');
    const costWindowOpen =
      idleTransition ||
      (wroteAssistantMessageItem &&
        (lastCostPersistedAtMs === null ||
          nowMs - lastCostPersistedAtMs >= COST_PERSIST_THROTTLE_MS));

    let currentCostMicrodollars: number | null = null;
    if (costWindowOpen) {
      const messageRows = this.db
        .select({ item_data: ingestItems.item_data })
        .from(ingestItems)
        .where(and(eq(ingestItems.item_type, 'message'), isNull(ingestItems.item_data_r2_key)))
        .all();
      const usd = computeRunningAssistantCostUsd(messageRows);
      currentCostMicrodollars = Math.max(0, Math.round(usd * 1_000_000));
    }

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

    if (decision.persistActivity || decision.persistCost) {
      const columns: {
        costMicrodollars?: number;
        lastActivityAtIso?: string;
        liveSummary?: { summary: SessionLiveSummary; atIso: string };
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
                      ingestedBeforeCondition,
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

  /**
   * The single DO alarm serves two schedules: session metrics (metricsAlarmAt) and
   * briefing evidence retries (briefingEvidenceRetryAt). Arms it for whichever is
   * due first, or clears it when neither is pending. Passing metricsAlarmAt records it.
   */
  private async scheduleAlarm(metricsAlarmAt?: number): Promise<void> {
    if (metricsAlarmAt !== undefined) {
      writeIngestMetaNumber(this.db, 'metricsAlarmAt', metricsAlarmAt);
    }
    const dueTimes = [
      metricsAlarmAt ?? readIngestMetaNumber(this.db, 'metricsAlarmAt'),
      readIngestMetaNumber(this.db, 'briefingEvidenceRetryAt'),
    ].filter((at): at is number => at !== null);
    if (dueTimes.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...dueTimes));
  }

  /**
   * Delivers the durable briefing evidence outbox. The backoff retry is recorded and
   * armed before the external write, so a failure or eviction mid-flush still retries.
   * Never throws: it runs under waitUntil and ahead of alarm metrics.
   */
  private async flushBriefingEvidence(kiloUserId: string, sessionId: string): Promise<void> {
    try {
      if (this.isDeleted()) return;
      const pendingEvidence = this.db
        .select()
        .from(ingestMeta)
        .where(sql`${ingestMeta.key} LIKE 'briefingEvidence:%'`)
        .all();
      if (pendingEvidence.length === 0) {
        const retryArmed = readIngestMetaNumber(this.db, 'briefingEvidenceRetryAt') !== null;
        this.db
          .delete(ingestMeta)
          .where(
            inArray(ingestMeta.key, [
              'briefingEvidencePending',
              'briefingEvidenceRetryAt',
              'briefingEvidenceRetryAttempt',
            ])
          )
          .run();
        if (retryArmed) await this.scheduleAlarm();
        return;
      }
      const retryAt = readIngestMetaNumber(this.db, 'briefingEvidenceRetryAt');
      if (retryAt !== null && retryAt > Date.now()) return;
      if (
        readIngestMetaNumber(this.db, 'metricsAlarmAt') === null &&
        readIngestMetaNumber(this.db, 'briefingEvidenceRetryAt') === null
      ) {
        // An alarm armed before metricsAlarmAt was recorded is a pending metrics alarm.
        const legacyMetricsAlarmAt = await this.ctx.storage.getAlarm();
        if (this.isDeleted()) return;
        if (legacyMetricsAlarmAt !== null) {
          writeIngestMetaNumber(this.db, 'metricsAlarmAt', legacyMetricsAlarmAt);
        }
      }
      const attempt = readIngestMetaNumber(this.db, 'briefingEvidenceRetryAttempt') ?? 0;
      writeIngestMetaNumber(this.db, 'briefingEvidenceRetryAttempt', attempt + 1);
      writeIngestMetaNumber(
        this.db,
        'briefingEvidenceRetryAt',
        Date.now() +
          Math.min(BRIEFING_EVIDENCE_RETRY_BASE_MS * 2 ** attempt, BRIEFING_EVIDENCE_RETRY_MAX_MS)
      );
      await this.scheduleAlarm();
      if (this.isDeleted()) return;

      const evidenceEvents = pendingEvidence.map<BriefingIngestEvent>(row => {
        if (row.value === null) throw new Error('Invalid persisted briefing evidence');
        const event: unknown = JSON.parse(row.value);
        if (
          typeof event !== 'object' ||
          event === null ||
          !('identity' in event) ||
          typeof event.identity !== 'string' ||
          !('occurredAt' in event) ||
          typeof event.occurredAt !== 'string' ||
          !Number.isFinite(Date.parse(event.occurredAt))
        ) {
          throw new Error('Invalid persisted briefing evidence');
        }
        if ('kind' in event && event.kind === 'status') {
          if (
            !('status' in event) ||
            typeof event.status !== 'string' ||
            !('previousStatus' in event) ||
            (event.previousStatus !== null && typeof event.previousStatus !== 'string') ||
            ('transitionId' in event &&
              (typeof event.transitionId !== 'string' ||
                !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(event.transitionId)))
          ) {
            throw new Error('Invalid persisted briefing status');
          }
          return {
            kind: 'status',
            identity: event.identity,
            occurredAt: event.occurredAt,
            status: event.status,
            previousStatus: event.previousStatus,
            previousStatusKnown:
              'previousStatusKnown' in event && event.previousStatusKnown === true,
            ...('transitionId' in event && typeof event.transitionId === 'string'
              ? { transitionId: event.transitionId }
              : {}),
          };
        }
        return {
          identity: event.identity,
          occurredAt: event.occurredAt,
          ...('excerpt' in event && typeof event.excerpt === 'string'
            ? { excerpt: event.excerpt }
            : {}),
        };
      });
      await persistBriefingEvidence(
        this.env.HYPERDRIVE.connectionString,
        kiloUserId,
        sessionId,
        evidenceEvents
      );
      if (this.isDeleted()) return;
      this.db
        .delete(ingestMeta)
        .where(
          inArray(
            ingestMeta.key,
            pendingEvidence.map(row => row.key)
          )
        )
        .run();
      const remaining = this.db
        .select({ key: ingestMeta.key })
        .from(ingestMeta)
        .where(sql`${ingestMeta.key} LIKE 'briefingEvidence:%'`)
        .limit(1)
        .all();
      const drained = remaining.length === 0;
      this.db
        .delete(ingestMeta)
        .where(
          inArray(ingestMeta.key, [
            'briefingEvidenceRetryAt',
            'briefingEvidenceRetryAttempt',
            ...(drained ? (['briefingEvidencePending'] as const) : []),
          ])
        )
        .run();
      await this.scheduleAlarm();
      if (!drained) await this.flushBriefingEvidence(kiloUserId, sessionId);
    } catch (error) {
      console.error('SessionIngestDO failed to flush briefing evidence', {
        kiloUserId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Flushes pending briefing evidence first, then emits session metrics only once
   * their own time is due: POST_CLOSE_DRAIN_MS after close or INACTIVITY_TIMEOUT_MS
   * without activity. An evidence retry never emits metrics early, and metrics
   * completion re-arms any pending retry. Reads the close reason from ingest_meta
   * if present, otherwise falls back to 'abandoned'.
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
          'briefingEvidencePending',
          'briefingEvidenceRetryAt',
        ])
      )
      .all();

    const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));

    if (meta['deleted'] === 'true') return;

    const kiloUserId = meta['kiloUserId'];
    const sessionId = meta['sessionId'];

    if (!kiloUserId || !sessionId) return;

    if (meta['briefingEvidencePending'] === 'true') {
      await this.flushBriefingEvidence(kiloUserId, sessionId);
      if (this.isDeleted()) return;
    }

    const metricsAlarmAt = readIngestMetaValue(this.db, 'metricsAlarmAt');
    // Without metricsAlarmAt, only an alarm armed before it was recorded (and not an
    // evidence retry) is a metrics alarm.
    const metricsDue =
      metricsAlarmAt !== null
        ? Number(metricsAlarmAt) <= Date.now()
        : meta['briefingEvidenceRetryAt'] == null && meta['metricsEmitted'] !== 'true';
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
    if (this.isDeleted()) {
      await cancelBody();
      return false;
    }
    writeIngestMetaIfChanged(this.db, { key: 'kiloUserId', incomingValue: params.kiloUserId });
    writeIngestMetaIfChanged(this.db, { key: 'sessionId', incomingValue: params.sessionId });
    const key = `pendingR2/${params.key}`;
    this.db
      .insert(ingestMeta)
      .values({ key, value: params.key })
      .onConflictDoUpdate({ target: ingestMeta.key, set: { value: params.key } })
      .run();
    const operation = (async () => {
      const reservation = await this.env.SESSION_INGEST_R2.put(params.key, crypto.randomUUID(), {
        onlyIf: new Headers({ 'If-None-Match': '*' }),
      });
      const etag = reservation?.etag ?? (await this.env.SESSION_INGEST_R2.head(params.key))?.etag;
      if (this.isDeleted()) {
        await cancelBody();
        await this.env.SESSION_INGEST_R2.delete(params.key);
        this.db.delete(ingestMeta).where(eq(ingestMeta.key, key)).run();
        return false;
      }
      if (!etag) throw new Error('Session R2 reservation disappeared');
      const written = await this.env.SESSION_INGEST_R2.put(params.key, body, {
        onlyIf: { etagMatches: etag },
      });
      const deleted = this.isDeleted();
      if (!written && !deleted) throw new Error('Session R2 reservation changed');
      if (deleted) await this.env.SESSION_INGEST_R2.delete(params.key);
      this.db.delete(ingestMeta).where(eq(ingestMeta.key, key)).run();
      return !deleted;
    })();
    this.activeR2Writes.add(operation);
    return operation.finally(() => this.activeR2Writes.delete(operation));
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
