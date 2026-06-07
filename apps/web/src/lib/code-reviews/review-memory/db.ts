import { createHash } from 'node:crypto';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  code_review_feedback_events,
  code_review_feedback_subjects,
  code_review_memory_aggregation_state,
  code_review_memory_proposals,
} from '@kilocode/db/schema';
import type {
  CodeReviewFeedbackEvent,
  CodeReviewFeedbackSubject,
  CodeReviewMemoryAggregationState,
  CodeReviewMemoryProposal,
} from '@kilocode/db/schema';
import type {
  ReviewMemoryAggregationScopeStatus,
  ReviewMemoryEventAggregationState,
  ReviewMemoryPlatform,
  ReviewMemoryProposalScopeKind,
  ReviewMemoryProposalStatus,
  ReviewMemoryProposalType,
  ReviewMemorySentiment,
  ReviewMemorySignalKind,
  ReviewMemorySubjectState,
  ReviewMemorySubjectType,
} from '@kilocode/db/schema-types';
import { and, asc, desc, eq, gte, inArray, lt, notExists, sql, type SQL } from 'drizzle-orm';
import { reviewMemoryRetentionCutoff } from './retention';

export type ReviewMemoryDatabase = typeof db | DrizzleTransaction;

export type ReviewMemoryOwner = { type: 'org'; id: string } | { type: 'user'; id: string };

export const ACTIONABLE_REVIEW_MEMORY_PROPOSAL_STATUSES = [
  'open',
  'edited',
  'change_request_failed',
] as const satisfies readonly ReviewMemoryProposalStatus[];

const IN_USE_REVIEW_MEMORY_PROPOSAL_STATUSES = [
  'approved',
  'opening_change_request',
  'change_request_opened',
] as const satisfies readonly ReviewMemoryProposalStatus[];

const DEFAULT_EXCERPT_LIMIT = 300;

function databaseOrDefault(database?: ReviewMemoryDatabase): ReviewMemoryDatabase {
  return database ?? db;
}

function ownerColumns(owner: ReviewMemoryOwner) {
  return owner.type === 'org'
    ? { owned_by_organization_id: owner.id, owned_by_user_id: null }
    : { owned_by_organization_id: null, owned_by_user_id: owner.id };
}

function ownerScope(owner: ReviewMemoryOwner): string {
  return `${owner.type}:${owner.id}`;
}

function subjectOwnerWhere(owner: ReviewMemoryOwner): SQL {
  return owner.type === 'org'
    ? eq(code_review_feedback_subjects.owned_by_organization_id, owner.id)
    : eq(code_review_feedback_subjects.owned_by_user_id, owner.id);
}

function eventOwnerWhere(owner: ReviewMemoryOwner): SQL {
  return owner.type === 'org'
    ? eq(code_review_feedback_events.owned_by_organization_id, owner.id)
    : eq(code_review_feedback_events.owned_by_user_id, owner.id);
}

function aggregationStateOwnerWhere(owner: ReviewMemoryOwner): SQL {
  return owner.type === 'org'
    ? eq(code_review_memory_aggregation_state.owned_by_organization_id, owner.id)
    : eq(code_review_memory_aggregation_state.owned_by_user_id, owner.id);
}

function proposalOwnerWhere(owner: ReviewMemoryOwner): SQL {
  return owner.type === 'org'
    ? eq(code_review_memory_proposals.owned_by_organization_id, owner.id)
    : eq(code_review_memory_proposals.owned_by_user_id, owner.id);
}

function retainedProposalWhere(now?: Date): SQL {
  return sql`(
    ${gte(code_review_memory_proposals.created_at, reviewMemoryRetentionCutoff(now))}
    OR ${inArray(code_review_memory_proposals.status, IN_USE_REVIEW_MEMORY_PROPOSAL_STATUSES)}
    OR ${code_review_memory_proposals.change_request_url} IS NOT NULL
  )`;
}

function retainedFreshEventWhere(now?: Date): SQL {
  return sql`${code_review_feedback_events.aggregation_state} = 'fresh' AND ${
    code_review_feedback_events.created_at
  } >= ${reviewMemoryRetentionCutoff(now)}`;
}

function aggregationStateFreshEventScopeWhere(cutoff: string): SQL {
  return sql`
    ${code_review_feedback_events.owned_by_organization_id} IS NOT DISTINCT FROM ${code_review_memory_aggregation_state.owned_by_organization_id}
    AND ${code_review_feedback_events.owned_by_user_id} IS NOT DISTINCT FROM ${code_review_memory_aggregation_state.owned_by_user_id}
    AND ${code_review_feedback_events.platform} = ${code_review_memory_aggregation_state.platform}
    AND ${code_review_feedback_events.repo_full_name} = ${code_review_memory_aggregation_state.repo_full_name}
    AND ${code_review_feedback_events.aggregation_state} = 'fresh'
    AND ${code_review_feedback_events.created_at} >= ${cutoff}
  `;
}

function aggregationStateProposalScopeWhere(cutoff: string): SQL {
  return sql`
    ${code_review_memory_proposals.owned_by_organization_id} IS NOT DISTINCT FROM ${code_review_memory_aggregation_state.owned_by_organization_id}
    AND ${code_review_memory_proposals.owned_by_user_id} IS NOT DISTINCT FROM ${code_review_memory_aggregation_state.owned_by_user_id}
    AND ${code_review_memory_proposals.platform} = ${code_review_memory_aggregation_state.platform}
    AND ${code_review_memory_proposals.repo_full_name} = ${code_review_memory_aggregation_state.repo_full_name}
    AND (
      ${code_review_memory_proposals.created_at} >= ${cutoff}
      OR ${inArray(code_review_memory_proposals.status, IN_USE_REVIEW_MEMORY_PROPOSAL_STATUSES)}
      OR ${code_review_memory_proposals.change_request_url} IS NOT NULL
    )
  `;
}

function aggregationStateHasRetainedDataWhere(cutoff: string): SQL {
  return sql`(
    EXISTS (
      SELECT 1
      FROM ${code_review_feedback_events}
      WHERE ${aggregationStateFreshEventScopeWhere(cutoff)}
    )
    OR EXISTS (
      SELECT 1
      FROM ${code_review_memory_proposals}
      WHERE ${aggregationStateProposalScopeWhere(cutoff)}
    )
  )`;
}

function retainedFreshEventCountForAggregationState(cutoff: string): SQL<number> {
  return sql<number>`(
    SELECT COUNT(*)::int
    FROM ${code_review_feedback_events}
    WHERE ${aggregationStateFreshEventScopeWhere(cutoff)}
  )`;
}

function compactText(
  value: string | null | undefined,
  limit = DEFAULT_EXCERPT_LIMIT
): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

export function createReviewMemoryDedupeHash(parts: readonly unknown[]): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        parts.map(part => {
          if (part === undefined) return null;
          return part;
        })
      )
    )
    .digest('hex');
}

export function createFeedbackSubjectExternalIdHash(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  subjectType: ReviewMemorySubjectType;
  idKind: 'subject' | 'thread';
  externalId: string;
}): string {
  return createReviewMemoryDedupeHash([
    'review-memory-subject-id',
    ownerScope(input.owner),
    input.platform,
    input.repoFullName,
    input.subjectType,
    input.idKind,
    input.externalId,
  ]);
}

export type UpsertFeedbackSubjectInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  subjectType: ReviewMemorySubjectType;
  externalId: string;
  externalThreadId?: string | null;
  repoFullName: string;
  platformProjectId?: number | null;
  prNumber?: number | null;
  filePath?: string | null;
  findingTitle?: string | null;
  findingFingerprint?: string | null;
  state?: ReviewMemorySubjectState;
  database?: ReviewMemoryDatabase;
};

export async function upsertFeedbackSubject(
  input: UpsertFeedbackSubjectInput
): Promise<CodeReviewFeedbackSubject> {
  const database = databaseOrDefault(input.database);
  const now = new Date().toISOString();
  const externalIdHash = createFeedbackSubjectExternalIdHash({
    owner: input.owner,
    platform: input.platform,
    repoFullName: input.repoFullName,
    subjectType: input.subjectType,
    idKind: 'subject',
    externalId: input.externalId,
  });
  const externalThreadIdHash = input.externalThreadId
    ? createFeedbackSubjectExternalIdHash({
        owner: input.owner,
        platform: input.platform,
        repoFullName: input.repoFullName,
        subjectType: input.subjectType,
        idKind: 'thread',
        externalId: input.externalThreadId,
      })
    : null;
  const conflictTarget =
    input.owner.type === 'org'
      ? [
          code_review_feedback_subjects.owned_by_organization_id,
          code_review_feedback_subjects.platform,
          code_review_feedback_subjects.repo_full_name,
          code_review_feedback_subjects.subject_type,
          code_review_feedback_subjects.external_id_hash,
        ]
      : [
          code_review_feedback_subjects.owned_by_user_id,
          code_review_feedback_subjects.platform,
          code_review_feedback_subjects.repo_full_name,
          code_review_feedback_subjects.subject_type,
          code_review_feedback_subjects.external_id_hash,
        ];
  const conflictTargetWhere =
    input.owner.type === 'org'
      ? sql`${code_review_feedback_subjects.owned_by_organization_id} IS NOT NULL`
      : sql`${code_review_feedback_subjects.owned_by_user_id} IS NOT NULL`;
  const [subject] = await database
    .insert(code_review_feedback_subjects)
    .values({
      ...ownerColumns(input.owner),
      platform: input.platform,
      subject_type: input.subjectType,
      external_id_hash: externalIdHash,
      external_thread_id_hash: externalThreadIdHash,
      repo_full_name: input.repoFullName,
      platform_project_id: input.platformProjectId ?? null,
      pr_number: input.prNumber ?? null,
      file_path: input.filePath ?? null,
      finding_title: input.findingTitle ?? null,
      finding_fingerprint: input.findingFingerprint ?? null,
      state: input.state ?? 'unknown',
      first_seen_at: now,
      last_seen_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: conflictTarget,
      targetWhere: conflictTargetWhere,
      set: {
        external_thread_id_hash: externalThreadIdHash,
        platform_project_id: input.platformProjectId ?? null,
        pr_number: input.prNumber ?? null,
        file_path: input.filePath ?? null,
        finding_title: input.findingTitle ?? null,
        finding_fingerprint: input.findingFingerprint ?? null,
        state: input.state ?? 'unknown',
        last_seen_at: now,
        updated_at: now,
      },
    })
    .returning();

  if (!subject) {
    throw new Error('Failed to upsert review memory subject');
  }

  return subject;
}

export type FindFeedbackSubjectInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  subjectType: ReviewMemorySubjectType;
  externalId: string;
  database?: ReviewMemoryDatabase;
};

export async function findFeedbackSubject(
  input: FindFeedbackSubjectInput
): Promise<CodeReviewFeedbackSubject | null> {
  const database = databaseOrDefault(input.database);
  const externalIdHash = createFeedbackSubjectExternalIdHash({
    owner: input.owner,
    platform: input.platform,
    repoFullName: input.repoFullName,
    subjectType: input.subjectType,
    idKind: 'subject',
    externalId: input.externalId,
  });
  const [subject] = await database
    .select()
    .from(code_review_feedback_subjects)
    .where(
      and(
        subjectOwnerWhere(input.owner),
        eq(code_review_feedback_subjects.platform, input.platform),
        eq(code_review_feedback_subjects.repo_full_name, input.repoFullName),
        eq(code_review_feedback_subjects.subject_type, input.subjectType),
        eq(code_review_feedback_subjects.external_id_hash, externalIdHash)
      )
    )
    .limit(1);

  return subject ?? null;
}

export type FindFeedbackSubjectByExternalThreadInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  subjectType: ReviewMemorySubjectType;
  externalThreadId: string;
  database?: ReviewMemoryDatabase;
};

export async function findFeedbackSubjectByExternalThreadId(
  input: FindFeedbackSubjectByExternalThreadInput
): Promise<CodeReviewFeedbackSubject | null> {
  const database = databaseOrDefault(input.database);
  const externalThreadIdHash = createFeedbackSubjectExternalIdHash({
    owner: input.owner,
    platform: input.platform,
    repoFullName: input.repoFullName,
    subjectType: input.subjectType,
    idKind: 'thread',
    externalId: input.externalThreadId,
  });
  const [subject] = await database
    .select()
    .from(code_review_feedback_subjects)
    .where(
      and(
        subjectOwnerWhere(input.owner),
        eq(code_review_feedback_subjects.platform, input.platform),
        eq(code_review_feedback_subjects.repo_full_name, input.repoFullName),
        eq(code_review_feedback_subjects.subject_type, input.subjectType),
        eq(code_review_feedback_subjects.external_thread_id_hash, externalThreadIdHash)
      )
    )
    .limit(1);

  return subject ?? null;
}

export type ListFeedbackSubjectsForPullRequestInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  prNumber: number;
  subjectTypes?: ReviewMemorySubjectType[];
  database?: ReviewMemoryDatabase;
};

export async function listFeedbackSubjectsForPullRequest(
  input: ListFeedbackSubjectsForPullRequestInput
): Promise<CodeReviewFeedbackSubject[]> {
  const database = databaseOrDefault(input.database);
  const conditions = [
    subjectOwnerWhere(input.owner),
    eq(code_review_feedback_subjects.platform, input.platform),
    eq(code_review_feedback_subjects.repo_full_name, input.repoFullName),
    eq(code_review_feedback_subjects.pr_number, input.prNumber),
  ] satisfies SQL[];

  if (input.subjectTypes && input.subjectTypes.length > 0) {
    conditions.push(inArray(code_review_feedback_subjects.subject_type, input.subjectTypes));
  }

  return await database
    .select()
    .from(code_review_feedback_subjects)
    .where(and(...conditions))
    .orderBy(desc(code_review_feedback_subjects.last_seen_at));
}

export async function updateFeedbackSubjectState(input: {
  subjectId: string;
  state: ReviewMemorySubjectState;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewFeedbackSubject | null> {
  const database = databaseOrDefault(input.database);
  const now = new Date().toISOString();
  const [subject] = await database
    .update(code_review_feedback_subjects)
    .set({ state: input.state, last_seen_at: now, updated_at: now })
    .where(eq(code_review_feedback_subjects.id, input.subjectId))
    .returning();

  return subject ?? null;
}

export async function hasFeedbackEventForSubject(input: {
  owner: ReviewMemoryOwner;
  subjectId: string;
  signalKinds: ReviewMemorySignalKind[];
  database?: ReviewMemoryDatabase;
}): Promise<boolean> {
  const database = databaseOrDefault(input.database);
  const [event] = await database
    .select({ id: code_review_feedback_events.id })
    .from(code_review_feedback_events)
    .where(
      and(
        eventOwnerWhere(input.owner),
        eq(code_review_feedback_events.subject_id, input.subjectId),
        inArray(code_review_feedback_events.signal_kind, input.signalKinds)
      )
    )
    .limit(1);

  return Boolean(event);
}

export type RecordFeedbackEventInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  subjectId?: string | null;
  repoFullName: string;
  platformProjectId?: number | null;
  prNumber?: number | null;
  signalKind: ReviewMemorySignalKind;
  sentiment: ReviewMemorySentiment;
  strength: number;
  dedupeHash: string;
  evidenceExcerpt?: string | null;
  occurredAt?: string | Date | null;
  refreshAggregationState?: boolean;
  database?: ReviewMemoryDatabase;
};

export type RecordFeedbackEventResult = {
  event: CodeReviewFeedbackEvent;
  created: boolean;
};

export async function recordFeedbackEvent(
  input: RecordFeedbackEventInput
): Promise<RecordFeedbackEventResult> {
  const database = databaseOrDefault(input.database);
  const occurredAt = input.occurredAt
    ? new Date(input.occurredAt).toISOString()
    : new Date().toISOString();
  const evidenceExcerpt = compactText(input.evidenceExcerpt);

  const [inserted] = await database
    .insert(code_review_feedback_events)
    .values({
      ...ownerColumns(input.owner),
      platform: input.platform,
      subject_id: input.subjectId ?? null,
      repo_full_name: input.repoFullName,
      platform_project_id: input.platformProjectId ?? null,
      pr_number: input.prNumber ?? null,
      signal_kind: input.signalKind,
      sentiment: input.sentiment,
      strength: input.strength,
      dedupe_hash: input.dedupeHash,
      evidence_excerpt: evidenceExcerpt,
      aggregation_state: 'fresh',
      occurred_at: occurredAt,
    })
    .onConflictDoNothing({ target: code_review_feedback_events.dedupe_hash })
    .returning();

  const shouldRefreshAggregationState = input.refreshAggregationState !== false;
  if (inserted) {
    if (shouldRefreshAggregationState) {
      await refreshAggregationStateForScope({
        owner: input.owner,
        platform: input.platform,
        repoFullName: input.repoFullName,
        platformProjectId: input.platformProjectId,
        database,
      });
    }
    return { event: inserted, created: true };
  }

  const [existing] = await database
    .select()
    .from(code_review_feedback_events)
    .where(eq(code_review_feedback_events.dedupe_hash, input.dedupeHash))
    .limit(1);

  if (!existing) {
    throw new Error('Failed to read deduped review memory feedback event');
  }

  if (shouldRefreshAggregationState) {
    await refreshAggregationStateForScope({
      owner: input.owner,
      platform: input.platform,
      repoFullName: input.repoFullName,
      platformProjectId: input.platformProjectId,
      database,
    });
  }

  return { event: existing, created: false };
}

export type RefreshAggregationStateInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  platformProjectId?: number | null;
  now?: Date;
  database?: ReviewMemoryDatabase;
};

export async function refreshAggregationStateForScope(
  input: RefreshAggregationStateInput
): Promise<CodeReviewMemoryAggregationState> {
  const database = databaseOrDefault(input.database);
  const now = input.now ?? new Date();
  const cutoff = reviewMemoryRetentionCutoff(now);
  const conditions = [
    eventOwnerWhere(input.owner),
    eq(code_review_feedback_events.platform, input.platform),
    eq(code_review_feedback_events.repo_full_name, input.repoFullName),
    eq(code_review_feedback_events.aggregation_state, 'fresh'),
    gte(code_review_feedback_events.created_at, cutoff),
  ] satisfies SQL[];

  const [rollup] = await database
    .select({
      eventCount: sql<number>`COUNT(*)::int`,
      freshWeight: sql<number>`COALESCE(SUM(${code_review_feedback_events.strength}), 0)::int`,
      distinctSubjectCount: sql<number>`COUNT(DISTINCT ${code_review_feedback_events.subject_id}) FILTER (WHERE ${code_review_feedback_events.subject_id} IS NOT NULL)::int`,
      distinctPrCount: sql<number>`COUNT(DISTINCT ${code_review_feedback_events.pr_number}) FILTER (WHERE ${code_review_feedback_events.pr_number} IS NOT NULL)::int`,
    })
    .from(code_review_feedback_events)
    .where(and(...conditions));

  const [existing] = await database
    .select()
    .from(code_review_memory_aggregation_state)
    .where(
      and(
        aggregationStateOwnerWhere(input.owner),
        eq(code_review_memory_aggregation_state.platform, input.platform),
        eq(code_review_memory_aggregation_state.repo_full_name, input.repoFullName)
      )
    )
    .limit(1);

  const eventCount = rollup?.eventCount ?? 0;
  const isFailedRetryBackoffActive =
    existing?.status === 'failed' && new Date(existing.next_eligible_at).getTime() > now.getTime();
  const status: ReviewMemoryAggregationScopeStatus =
    existing?.status === 'running'
      ? 'running'
      : isFailedRetryBackoffActive
        ? 'failed'
        : eventCount > 0
          ? 'eligible'
          : 'idle';
  const updatedAt = now.toISOString();
  const stateValues = {
    fresh_event_count: eventCount,
    fresh_weight: rollup?.freshWeight ?? 0,
    fresh_distinct_subject_count: rollup?.distinctSubjectCount ?? 0,
    fresh_distinct_pr_count: rollup?.distinctPrCount ?? 0,
    platform_project_id: input.platformProjectId ?? existing?.platform_project_id ?? null,
    status,
    updated_at: updatedAt,
  };

  if (existing) {
    const [updated] = await database
      .update(code_review_memory_aggregation_state)
      .set(stateValues)
      .where(eq(code_review_memory_aggregation_state.id, existing.id))
      .returning();

    if (!updated) throw new Error('Failed to update review memory aggregation state');
    return updated;
  }

  const [inserted] = await database
    .insert(code_review_memory_aggregation_state)
    .values({
      ...ownerColumns(input.owner),
      platform: input.platform,
      repo_full_name: input.repoFullName,
      ...stateValues,
      next_eligible_at: updatedAt,
    })
    .returning();

  if (!inserted) throw new Error('Failed to insert review memory aggregation state');
  return inserted;
}

export type PruneExpiredReviewMemoryDataSummary = {
  cutoff: string;
  proposalsDeleted: number;
  feedbackEventsDeleted: number;
  subjectsDeleted: number;
  aggregationStatesDeleted: number;
};

const DEFAULT_REVIEW_MEMORY_PRUNE_BATCH_SIZE = 500;
const MAX_REVIEW_MEMORY_PRUNE_BATCH_SIZE = 5_000;
const DEFAULT_REVIEW_MEMORY_PRUNE_MAX_BATCHES = 20;
const MAX_REVIEW_MEMORY_PRUNE_MAX_BATCHES = 100;

type ReviewMemoryScopeRow = {
  ownedByOrganizationId: string | null;
  ownedByUserId: string | null;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  platformProjectId: number | null;
};

function ownerFromScopeRow(row: ReviewMemoryScopeRow): ReviewMemoryOwner | null {
  if (row.ownedByOrganizationId) return { type: 'org', id: row.ownedByOrganizationId };
  if (row.ownedByUserId) return { type: 'user', id: row.ownedByUserId };
  return null;
}

async function refreshAggregationScopes(input: {
  scopes: ReviewMemoryScopeRow[];
  now: Date;
  database: ReviewMemoryDatabase;
}): Promise<void> {
  const seen = new Set<string>();
  for (const scope of input.scopes) {
    const owner = ownerFromScopeRow(scope);
    if (!owner) continue;

    const key = [owner.type, owner.id, scope.platform, scope.repoFullName].join(':');
    if (seen.has(key)) continue;
    seen.add(key);

    await refreshAggregationStateForScope({
      owner,
      platform: scope.platform,
      repoFullName: scope.repoFullName,
      platformProjectId: scope.platformProjectId,
      now: input.now,
      database: input.database,
    });
  }
}

export async function pruneExpiredReviewMemoryData(
  input: {
    now?: Date;
    batchSize?: number;
    maxBatches?: number;
    database?: ReviewMemoryDatabase;
  } = {}
): Promise<PruneExpiredReviewMemoryDataSummary> {
  const database = databaseOrDefault(input.database);
  const now = input.now ?? new Date();
  const cutoff = reviewMemoryRetentionCutoff(now);
  const batchSize = Math.max(
    1,
    Math.min(
      input.batchSize ?? DEFAULT_REVIEW_MEMORY_PRUNE_BATCH_SIZE,
      MAX_REVIEW_MEMORY_PRUNE_BATCH_SIZE
    )
  );
  const maxBatches = Math.max(
    1,
    Math.min(
      input.maxBatches ?? DEFAULT_REVIEW_MEMORY_PRUNE_MAX_BATCHES,
      MAX_REVIEW_MEMORY_PRUNE_MAX_BATCHES
    )
  );
  let batchesUsed = 0;
  let proposalsDeleted = 0;
  while (batchesUsed < maxBatches) {
    const expiredProposalIds = await database
      .select({ id: code_review_memory_proposals.id })
      .from(code_review_memory_proposals)
      .where(
        and(
          lt(code_review_memory_proposals.created_at, cutoff),
          sql`NOT ${retainedProposalWhere(now)}`
        )
      )
      .orderBy(asc(code_review_memory_proposals.created_at), asc(code_review_memory_proposals.id))
      .limit(batchSize);
    if (expiredProposalIds.length === 0) break;
    batchesUsed += 1;

    const deletedProposals = await database
      .delete(code_review_memory_proposals)
      .where(
        inArray(
          code_review_memory_proposals.id,
          expiredProposalIds.map(row => row.id)
        )
      )
      .returning({ id: code_review_memory_proposals.id });
    proposalsDeleted += deletedProposals.length;
    if (expiredProposalIds.length < batchSize || deletedProposals.length === 0) break;
  }

  let feedbackEventsDeleted = 0;
  const expiredEventScopes: ReviewMemoryScopeRow[] = [];
  while (batchesUsed < maxBatches) {
    const expiredEventRows = await database
      .select({
        id: code_review_feedback_events.id,
        ownedByOrganizationId: code_review_feedback_events.owned_by_organization_id,
        ownedByUserId: code_review_feedback_events.owned_by_user_id,
        platform: code_review_feedback_events.platform,
        repoFullName: code_review_feedback_events.repo_full_name,
        platformProjectId: code_review_feedback_events.platform_project_id,
      })
      .from(code_review_feedback_events)
      .where(lt(code_review_feedback_events.created_at, cutoff))
      .orderBy(asc(code_review_feedback_events.created_at), asc(code_review_feedback_events.id))
      .limit(batchSize);
    if (expiredEventRows.length === 0) break;
    batchesUsed += 1;

    const deletedFeedbackEvents = await database
      .delete(code_review_feedback_events)
      .where(
        inArray(
          code_review_feedback_events.id,
          expiredEventRows.map(row => row.id)
        )
      )
      .returning({ id: code_review_feedback_events.id });
    feedbackEventsDeleted += deletedFeedbackEvents.length;
    expiredEventScopes.push(...expiredEventRows);
    if (expiredEventRows.length < batchSize || deletedFeedbackEvents.length === 0) break;
  }

  await refreshAggregationScopes({ scopes: expiredEventScopes, now, database });

  let subjectsDeleted = 0;
  while (batchesUsed < maxBatches) {
    const expiredSubjectIds = await database
      .select({ id: code_review_feedback_subjects.id })
      .from(code_review_feedback_subjects)
      .where(
        and(
          lt(code_review_feedback_subjects.last_seen_at, cutoff),
          notExists(
            database
              .select({ one: sql`1` })
              .from(code_review_feedback_events)
              .where(eq(code_review_feedback_events.subject_id, code_review_feedback_subjects.id))
          )
        )
      )
      .orderBy(
        asc(code_review_feedback_subjects.last_seen_at),
        asc(code_review_feedback_subjects.id)
      )
      .limit(batchSize);
    if (expiredSubjectIds.length === 0) break;
    batchesUsed += 1;

    const deletedSubjects = await database
      .delete(code_review_feedback_subjects)
      .where(
        inArray(
          code_review_feedback_subjects.id,
          expiredSubjectIds.map(row => row.id)
        )
      )
      .returning({ id: code_review_feedback_subjects.id });
    subjectsDeleted += deletedSubjects.length;
    if (expiredSubjectIds.length < batchSize || deletedSubjects.length === 0) break;
  }

  let aggregationStatesDeleted = 0;
  while (batchesUsed < maxBatches) {
    const expiredAggregationStateIds = await database
      .select({ id: code_review_memory_aggregation_state.id })
      .from(code_review_memory_aggregation_state)
      .where(sql`NOT ${aggregationStateHasRetainedDataWhere(cutoff)}`)
      .orderBy(
        asc(code_review_memory_aggregation_state.updated_at),
        asc(code_review_memory_aggregation_state.id)
      )
      .limit(batchSize);
    if (expiredAggregationStateIds.length === 0) break;
    batchesUsed += 1;

    const deletedAggregationStates = await database
      .delete(code_review_memory_aggregation_state)
      .where(
        inArray(
          code_review_memory_aggregation_state.id,
          expiredAggregationStateIds.map(row => row.id)
        )
      )
      .returning({ id: code_review_memory_aggregation_state.id });
    aggregationStatesDeleted += deletedAggregationStates.length;
    if (expiredAggregationStateIds.length < batchSize || deletedAggregationStates.length === 0)
      break;
  }

  return {
    cutoff,
    proposalsDeleted,
    feedbackEventsDeleted,
    subjectsDeleted,
    aggregationStatesDeleted,
  };
}

export type ClaimEligibleAggregationStatesInput = {
  limit?: number;
  stateId?: string;
  minFreshEvents: number;
  minFreshWeight: number;
  minDistinctSubjects: number;
  minDistinctPrs: number;
  staleAfterMs: number;
  bypassEligibleCooldown?: boolean;
  now?: Date;
};

export async function claimEligibleAggregationStates(
  input: ClaimEligibleAggregationStatesInput
): Promise<CodeReviewMemoryAggregationState[]> {
  const now = input.now ?? new Date();
  const cutoff = reviewMemoryRetentionCutoff(now);
  const staleBefore = new Date(now.getTime() - input.staleAfterMs).toISOString();
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  const stateIdFilter = input.stateId ? sql`AND id = ${input.stateId}::uuid` : sql``;
  const result = await db.execute<CodeReviewMemoryAggregationState>(sql`
    WITH candidates AS (
      SELECT id
      FROM ${code_review_memory_aggregation_state}
      WHERE
        TRUE
        ${stateIdFilter}
        AND (
          (
            (
              (
                status = 'eligible'
                AND (${input.bypassEligibleCooldown ?? false} OR next_eligible_at <= ${now.toISOString()})
              )
              OR (
                status = 'failed'
                AND next_eligible_at <= ${now.toISOString()}
              )
            )
            AND EXISTS (
              SELECT 1
              FROM ${code_review_feedback_events}
              WHERE ${aggregationStateFreshEventScopeWhere(cutoff)}
            )
            AND (fresh_event_count >= ${input.minFreshEvents} OR fresh_weight >= ${input.minFreshWeight})
            AND (
              fresh_distinct_subject_count >= ${input.minDistinctSubjects}
              OR fresh_distinct_pr_count >= ${input.minDistinctPrs}
            )
          ) OR (
            status = 'running'
            AND claimed_at IS NOT NULL
            AND claimed_at <= ${staleBefore}
          )
        )
      ORDER BY fresh_weight DESC, fresh_event_count DESC, updated_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE ${code_review_memory_aggregation_state} state
    SET
      status = 'running',
      claimed_at = ${now.toISOString()},
      claim_token = gen_random_uuid()::text,
      updated_at = ${now.toISOString()}
    FROM candidates
    WHERE state.id = candidates.id
    RETURNING state.*
  `);

  return result.rows;
}

export async function finishClaimedAggregationState(input: {
  stateId: string;
  claimToken: string;
  status: Extract<ReviewMemoryAggregationScopeStatus, 'idle' | 'failed'>;
  nextEligibleAt: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryAggregationState | null> {
  const database = databaseOrDefault(input.database);
  const updateValues: Partial<typeof code_review_memory_aggregation_state.$inferInsert> = {
    status: input.status,
    claimed_at: null,
    claim_token: null,
    next_eligible_at: input.nextEligibleAt,
    updated_at: new Date().toISOString(),
  };

  const [state] = await database
    .update(code_review_memory_aggregation_state)
    .set(updateValues)
    .where(
      and(
        eq(code_review_memory_aggregation_state.id, input.stateId),
        eq(code_review_memory_aggregation_state.claim_token, input.claimToken)
      )
    )
    .returning();

  return state ?? null;
}

export type UpsertProposalInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  platformProjectId?: number | null;
  scopeKind: ReviewMemoryProposalScopeKind;
  scopeValue?: string | null;
  proposalType: ReviewMemoryProposalType;
  title: string;
  rationale: string;
  proposedMarkdown: string;
  dedupeKey: string;
  llmConfidence?: number | null;
  positiveCount?: number;
  negativeCount?: number;
  neutralCount?: number;
  distinctPrCount?: number;
  distinctSubjectCount?: number;
  contradictoryCount?: number;
  database?: ReviewMemoryDatabase;
};

export async function upsertReviewMemoryProposal(
  input: UpsertProposalInput
): Promise<CodeReviewMemoryProposal> {
  const database = databaseOrDefault(input.database);
  const activeStatuses = [
    'open',
    'edited',
    'approved',
    'opening_change_request',
    'change_request_opened',
  ] satisfies ReviewMemoryProposalStatus[];

  const [existing] = await database
    .select()
    .from(code_review_memory_proposals)
    .where(
      and(
        proposalOwnerWhere(input.owner),
        eq(code_review_memory_proposals.platform, input.platform),
        eq(code_review_memory_proposals.repo_full_name, input.repoFullName),
        eq(code_review_memory_proposals.dedupe_key, input.dedupeKey),
        retainedProposalWhere(),
        inArray(code_review_memory_proposals.status, activeStatuses)
      )
    )
    .limit(1);

  const values = {
    platform_project_id: input.platformProjectId ?? null,
    scope_kind: input.scopeKind,
    scope_value: input.scopeValue ?? null,
    proposal_type: input.proposalType,
    title: input.title,
    rationale: input.rationale,
    proposed_markdown: input.proposedMarkdown,
    llm_confidence: input.llmConfidence ?? null,
    positive_count: input.positiveCount ?? 0,
    negative_count: input.negativeCount ?? 0,
    neutral_count: input.neutralCount ?? 0,
    distinct_pr_count: input.distinctPrCount ?? 0,
    distinct_subject_count: input.distinctSubjectCount ?? 0,
    contradictory_count: input.contradictoryCount ?? 0,
    updated_at: new Date().toISOString(),
  };

  const proposal = existing
    ? await updateProposalById(database, existing.id, values)
    : await insertProposal(database, input, values);

  return proposal;
}

async function insertProposal(
  database: ReviewMemoryDatabase,
  input: UpsertProposalInput,
  values: Partial<typeof code_review_memory_proposals.$inferInsert>
): Promise<CodeReviewMemoryProposal> {
  const [proposal] = await database
    .insert(code_review_memory_proposals)
    .values({
      ...ownerColumns(input.owner),
      platform: input.platform,
      repo_full_name: input.repoFullName,
      proposal_type: input.proposalType,
      title: input.title,
      rationale: input.rationale,
      proposed_markdown: input.proposedMarkdown,
      dedupe_key: input.dedupeKey,
      ...values,
    })
    .returning();

  if (!proposal) throw new Error('Failed to insert review memory proposal');
  return proposal;
}

async function updateProposalById(
  database: ReviewMemoryDatabase,
  proposalId: string,
  values: Partial<typeof code_review_memory_proposals.$inferInsert>
): Promise<CodeReviewMemoryProposal> {
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set(values)
    .where(eq(code_review_memory_proposals.id, proposalId))
    .returning();

  if (!proposal) throw new Error('Failed to update review memory proposal');
  return proposal;
}

export async function listFeedbackEventsForAggregation(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  limit?: number;
  database?: ReviewMemoryDatabase;
}): Promise<(CodeReviewFeedbackEvent & { subject: CodeReviewFeedbackSubject | null })[]> {
  const database = databaseOrDefault(input.database);
  const rows = await database
    .select({
      event: code_review_feedback_events,
      subject: code_review_feedback_subjects,
    })
    .from(code_review_feedback_events)
    .leftJoin(
      code_review_feedback_subjects,
      eq(code_review_feedback_events.subject_id, code_review_feedback_subjects.id)
    )
    .where(
      and(
        eventOwnerWhere(input.owner),
        eq(code_review_feedback_events.platform, input.platform),
        eq(code_review_feedback_events.repo_full_name, input.repoFullName),
        retainedFreshEventWhere()
      )
    )
    .orderBy(desc(code_review_feedback_events.created_at))
    .limit(Math.min(input.limit ?? 200, 500));

  return rows.map(row => ({ ...row.event, subject: row.subject }));
}

export async function markFeedbackEventsIncluded(input: {
  eventIds: string[];
  database?: ReviewMemoryDatabase;
}): Promise<void> {
  if (input.eventIds.length === 0) return;
  const database = databaseOrDefault(input.database);
  await database
    .update(code_review_feedback_events)
    .set({ aggregation_state: 'included' })
    .where(inArray(code_review_feedback_events.id, input.eventIds));
}

export async function markFeedbackEventsAggregationState(input: {
  eventIds: string[];
  aggregationState: ReviewMemoryEventAggregationState;
  database?: ReviewMemoryDatabase;
}): Promise<void> {
  if (input.eventIds.length === 0) return;
  const database = databaseOrDefault(input.database);
  await database
    .update(code_review_feedback_events)
    .set({ aggregation_state: input.aggregationState })
    .where(inArray(code_review_feedback_events.id, input.eventIds));
}

export async function listAggregationStates(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName?: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryAggregationState[]> {
  const database = databaseOrDefault(input.database);
  const cutoff = reviewMemoryRetentionCutoff();
  const conditions: SQL[] = [
    aggregationStateOwnerWhere(input.owner),
    eq(code_review_memory_aggregation_state.platform, input.platform),
    aggregationStateHasRetainedDataWhere(cutoff),
  ];
  if (input.repoFullName) {
    conditions.push(eq(code_review_memory_aggregation_state.repo_full_name, input.repoFullName));
  }
  return await database
    .select()
    .from(code_review_memory_aggregation_state)
    .where(and(...conditions))
    .orderBy(desc(code_review_memory_aggregation_state.updated_at));
}

export async function listReviewMemoryRepositories(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  database?: ReviewMemoryDatabase;
}): Promise<{ repoFullName: string; platformProjectId: number | null; freshEventCount: number }[]> {
  const database = databaseOrDefault(input.database);
  const cutoff = reviewMemoryRetentionCutoff();
  const rows = await database
    .select({
      repoFullName: code_review_memory_aggregation_state.repo_full_name,
      platformProjectId: code_review_memory_aggregation_state.platform_project_id,
      freshEventCount: retainedFreshEventCountForAggregationState(cutoff),
    })
    .from(code_review_memory_aggregation_state)
    .where(
      and(
        aggregationStateOwnerWhere(input.owner),
        eq(code_review_memory_aggregation_state.platform, input.platform),
        aggregationStateHasRetainedDataWhere(cutoff)
      )
    )
    .orderBy(desc(code_review_memory_aggregation_state.updated_at));

  return rows;
}

export async function countActionableProposals(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName?: string;
  database?: ReviewMemoryDatabase;
}): Promise<number> {
  const database = databaseOrDefault(input.database);
  const conditions: SQL[] = [
    proposalOwnerWhere(input.owner),
    eq(code_review_memory_proposals.platform, input.platform),
    retainedProposalWhere(),
    inArray(code_review_memory_proposals.status, ACTIONABLE_REVIEW_MEMORY_PROPOSAL_STATUSES),
  ];
  if (input.repoFullName) {
    conditions.push(eq(code_review_memory_proposals.repo_full_name, input.repoFullName));
  }

  const [row] = await database
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(code_review_memory_proposals)
    .where(and(...conditions));

  return row?.count ?? 0;
}

export async function listReviewMemoryProposals(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName?: string;
  statuses?: ReviewMemoryProposalStatus[];
  proposalType?: ReviewMemoryProposalType;
  limit?: number;
  offset?: number;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal[]> {
  const database = databaseOrDefault(input.database);
  const conditions: SQL[] = [
    proposalOwnerWhere(input.owner),
    eq(code_review_memory_proposals.platform, input.platform),
    retainedProposalWhere(),
  ];
  if (input.repoFullName)
    conditions.push(eq(code_review_memory_proposals.repo_full_name, input.repoFullName));
  if (input.statuses?.length)
    conditions.push(inArray(code_review_memory_proposals.status, input.statuses));
  if (input.proposalType)
    conditions.push(eq(code_review_memory_proposals.proposal_type, input.proposalType));

  return await database
    .select()
    .from(code_review_memory_proposals)
    .where(and(...conditions))
    .orderBy(desc(code_review_memory_proposals.updated_at))
    .limit(Math.min(input.limit ?? 50, 100))
    .offset(input.offset ?? 0);
}

export async function getReviewMemoryProposal(input: {
  owner: ReviewMemoryOwner;
  proposalId: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = databaseOrDefault(input.database);
  const [proposal] = await database
    .select()
    .from(code_review_memory_proposals)
    .where(
      and(
        proposalOwnerWhere(input.owner),
        eq(code_review_memory_proposals.id, input.proposalId),
        retainedProposalWhere()
      )
    )
    .limit(1);

  return proposal ?? null;
}

export async function updateReviewMemoryProposal(input: {
  owner: ReviewMemoryOwner;
  proposalId: string;
  title: string;
  rationale: string;
  proposedMarkdown: string;
  scopeKind: ReviewMemoryProposalScopeKind;
  scopeValue?: string | null;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = databaseOrDefault(input.database);
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({
      title: input.title,
      rationale: input.rationale,
      proposed_markdown: input.proposedMarkdown,
      scope_kind: input.scopeKind,
      scope_value: input.scopeValue ?? null,
      status: 'edited',
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        proposalOwnerWhere(input.owner),
        eq(code_review_memory_proposals.id, input.proposalId),
        retainedProposalWhere(),
        inArray(code_review_memory_proposals.status, ACTIONABLE_REVIEW_MEMORY_PROPOSAL_STATUSES)
      )
    )
    .returning();

  return proposal ?? null;
}

export async function rejectReviewMemoryProposal(input: {
  owner: ReviewMemoryOwner;
  proposalId: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = databaseOrDefault(input.database);
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({
      status: 'rejected',
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        proposalOwnerWhere(input.owner),
        eq(code_review_memory_proposals.id, input.proposalId),
        retainedProposalWhere(),
        inArray(code_review_memory_proposals.status, ACTIONABLE_REVIEW_MEMORY_PROPOSAL_STATUSES)
      )
    )
    .returning();

  return proposal ?? null;
}

export async function markProposalOpeningChangeRequest(input: {
  owner: ReviewMemoryOwner;
  proposalId: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = databaseOrDefault(input.database);
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({
      status: 'opening_change_request',
      change_request_error_message: null,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        proposalOwnerWhere(input.owner),
        eq(code_review_memory_proposals.id, input.proposalId),
        retainedProposalWhere(),
        inArray(code_review_memory_proposals.status, ACTIONABLE_REVIEW_MEMORY_PROPOSAL_STATUSES)
      )
    )
    .returning();

  return proposal ?? null;
}

export async function markProposalChangeRequestOpened(input: {
  proposalId: string;
  changeRequestUrl: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal> {
  const database = databaseOrDefault(input.database);
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({
      status: 'change_request_opened',
      change_request_url: input.changeRequestUrl,
      change_request_error_message: null,
      updated_at: new Date().toISOString(),
    })
    .where(eq(code_review_memory_proposals.id, input.proposalId))
    .returning();

  if (!proposal) throw new Error('Failed to mark review memory change request opened');
  return proposal;
}

export async function markProposalChangeRequestFailed(input: {
  proposalId: string;
  errorMessage: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal> {
  const database = databaseOrDefault(input.database);
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({
      status: 'change_request_failed',
      change_request_error_message: compactText(input.errorMessage, 1_000),
      updated_at: new Date().toISOString(),
    })
    .where(eq(code_review_memory_proposals.id, input.proposalId))
    .returning();

  if (!proposal) throw new Error('Failed to mark review memory change request failed');
  return proposal;
}

export async function markProposalSuperseded(input: {
  proposalId: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal> {
  const database = databaseOrDefault(input.database);
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({
      status: 'superseded',
      updated_at: new Date().toISOString(),
    })
    .where(eq(code_review_memory_proposals.id, input.proposalId))
    .returning();

  if (!proposal) throw new Error('Failed to mark review memory proposal superseded');
  return proposal;
}
