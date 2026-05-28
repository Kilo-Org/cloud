import { createHash } from 'node:crypto';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  code_review_feedback_events,
  code_review_feedback_subjects,
  code_review_memory_aggregation_runs,
  code_review_memory_aggregation_state,
  code_review_memory_proposal_evidence,
  code_review_memory_proposals,
} from '@kilocode/db/schema';
import type {
  CodeReviewFeedbackEvent,
  CodeReviewFeedbackSubject,
  CodeReviewMemoryAggregationRun,
  CodeReviewMemoryAggregationState,
  CodeReviewMemoryProposal,
} from '@kilocode/db/schema';
import type {
  ReviewMemoryAggregationScopeStatus,
  ReviewMemoryAggregationRunStatus,
  ReviewMemoryAggregationRunTrigger,
  ReviewMemoryChangeRequestType,
  ReviewMemoryEvidenceRole,
  ReviewMemoryFeedbackEventSource,
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
import {
  and,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  lt,
  notExists,
  sql,
  type SQL,
} from 'drizzle-orm';
import { reviewMemoryRetentionCutoff } from './retention';

export type ReviewMemoryDatabase = typeof db | DrizzleTransaction;

export type ReviewMemoryOwner = { type: 'org'; id: string } | { type: 'user'; id: string };

export const ACTIONABLE_REVIEW_MEMORY_PROPOSAL_STATUSES = [
  'open',
  'edited',
  'change_request_failed',
] as const satisfies readonly ReviewMemoryProposalStatus[];

const DEFAULT_EXCERPT_LIMIT = 500;

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
  return gte(code_review_memory_proposals.created_at, reviewMemoryRetentionCutoff(now));
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
    AND ${code_review_memory_proposals.created_at} >= ${cutoff}
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

function retainedFreshEventWeightForAggregationState(cutoff: string): SQL<number> {
  return sql<number>`(
    SELECT COALESCE(SUM(${code_review_feedback_events.strength}), 0)::int
    FROM ${code_review_feedback_events}
    WHERE ${aggregationStateFreshEventScopeWhere(cutoff)}
  )`;
}

function retainedFreshEventSubjectCountForAggregationState(cutoff: string): SQL<number> {
  return sql<number>`(
    SELECT COUNT(DISTINCT ${code_review_feedback_events.subject_id}) FILTER (WHERE ${code_review_feedback_events.subject_id} IS NOT NULL)::int
    FROM ${code_review_feedback_events}
    WHERE ${aggregationStateFreshEventScopeWhere(cutoff)}
  )`;
}

function retainedFreshEventPrCountForAggregationState(cutoff: string): SQL<number> {
  return sql<number>`(
    SELECT COUNT(DISTINCT ${code_review_feedback_events.pr_number}) FILTER (WHERE ${code_review_feedback_events.pr_number} IS NOT NULL)::int
    FROM ${code_review_feedback_events}
    WHERE ${aggregationStateFreshEventScopeWhere(cutoff)}
  )`;
}

function retainedLastFreshEventCreatedAtForAggregationState(cutoff: string): SQL<string | null> {
  return sql<string | null>`(
    SELECT MAX(${code_review_feedback_events.created_at})
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

export type UpsertFeedbackSubjectInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  platformIntegrationId?: string | null;
  codeReviewId?: string | null;
  subjectType: ReviewMemorySubjectType;
  externalId: string;
  externalThreadId?: string | null;
  externalUrl?: string | null;
  repoFullName: string;
  platformProjectId?: number | null;
  prNumber?: number | null;
  prUrl?: string | null;
  headSha?: string | null;
  filePath?: string | null;
  lineNumber?: number | null;
  diffHunk?: string | null;
  bodyExcerpt?: string | null;
  severity?: string | null;
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
  const [subject] = await database
    .insert(code_review_feedback_subjects)
    .values({
      ...ownerColumns(input.owner),
      platform: input.platform,
      platform_integration_id: input.platformIntegrationId ?? null,
      code_review_id: input.codeReviewId ?? null,
      subject_type: input.subjectType,
      external_id: input.externalId,
      external_thread_id: input.externalThreadId ?? null,
      external_url: input.externalUrl ?? null,
      repo_full_name: input.repoFullName,
      platform_project_id: input.platformProjectId ?? null,
      pr_number: input.prNumber ?? null,
      pr_url: input.prUrl ?? null,
      head_sha: input.headSha ?? null,
      file_path: input.filePath ?? null,
      line_number: input.lineNumber ?? null,
      diff_hunk: compactText(input.diffHunk, 1_000),
      body_excerpt: compactText(input.bodyExcerpt),
      severity: input.severity ?? null,
      finding_title: input.findingTitle ?? null,
      finding_fingerprint: input.findingFingerprint ?? null,
      state: input.state ?? 'unknown',
      first_seen_at: now,
      last_seen_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        code_review_feedback_subjects.platform,
        code_review_feedback_subjects.repo_full_name,
        code_review_feedback_subjects.subject_type,
        code_review_feedback_subjects.external_id,
      ],
      set: {
        owned_by_organization_id: ownerColumns(input.owner).owned_by_organization_id,
        owned_by_user_id: ownerColumns(input.owner).owned_by_user_id,
        platform_integration_id: input.platformIntegrationId ?? null,
        code_review_id: input.codeReviewId ?? null,
        external_thread_id: input.externalThreadId ?? null,
        external_url: input.externalUrl ?? null,
        platform_project_id: input.platformProjectId ?? null,
        pr_number: input.prNumber ?? null,
        pr_url: input.prUrl ?? null,
        head_sha: input.headSha ?? null,
        file_path: input.filePath ?? null,
        line_number: input.lineNumber ?? null,
        diff_hunk: compactText(input.diffHunk, 1_000),
        body_excerpt: compactText(input.bodyExcerpt),
        severity: input.severity ?? null,
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
  const [subject] = await database
    .select()
    .from(code_review_feedback_subjects)
    .where(
      and(
        subjectOwnerWhere(input.owner),
        eq(code_review_feedback_subjects.platform, input.platform),
        eq(code_review_feedback_subjects.repo_full_name, input.repoFullName),
        eq(code_review_feedback_subjects.subject_type, input.subjectType),
        eq(code_review_feedback_subjects.external_id, input.externalId)
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
  const [subject] = await database
    .select()
    .from(code_review_feedback_subjects)
    .where(
      and(
        subjectOwnerWhere(input.owner),
        eq(code_review_feedback_subjects.platform, input.platform),
        eq(code_review_feedback_subjects.repo_full_name, input.repoFullName),
        eq(code_review_feedback_subjects.subject_type, input.subjectType),
        eq(code_review_feedback_subjects.external_thread_id, input.externalThreadId)
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

export type RecordFeedbackEventInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  platformIntegrationId?: string | null;
  subjectId?: string | null;
  codeReviewId?: string | null;
  repoFullName: string;
  platformProjectId?: number | null;
  prNumber?: number | null;
  prUrl?: string | null;
  eventSource: ReviewMemoryFeedbackEventSource;
  signalKind: ReviewMemorySignalKind;
  sentiment: ReviewMemorySentiment;
  strength: number;
  externalEventId?: string | null;
  dedupeHash?: string | null;
  externalUrl?: string | null;
  evidenceExcerpt?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: string | Date | null;
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
  const dedupeHash =
    input.dedupeHash ??
    createReviewMemoryDedupeHash([
      ownerScope(input.owner),
      input.platform,
      input.repoFullName,
      input.externalEventId,
      input.subjectId,
      input.signalKind,
      evidenceExcerpt,
      occurredAt,
    ]);

  const [inserted] = await database
    .insert(code_review_feedback_events)
    .values({
      ...ownerColumns(input.owner),
      platform: input.platform,
      platform_integration_id: input.platformIntegrationId ?? null,
      subject_id: input.subjectId ?? null,
      code_review_id: input.codeReviewId ?? null,
      repo_full_name: input.repoFullName,
      platform_project_id: input.platformProjectId ?? null,
      pr_number: input.prNumber ?? null,
      pr_url: input.prUrl ?? null,
      event_source: input.eventSource,
      signal_kind: input.signalKind,
      sentiment: input.sentiment,
      strength: input.strength,
      external_event_id: input.externalEventId ?? null,
      dedupe_hash: dedupeHash,
      external_url: input.externalUrl ?? null,
      evidence_excerpt: evidenceExcerpt,
      metadata: input.metadata ?? {},
      aggregation_state: 'fresh',
      occurred_at: occurredAt,
    })
    .onConflictDoNothing({ target: code_review_feedback_events.dedupe_hash })
    .returning();

  if (inserted) {
    await refreshAggregationStateForScope({
      owner: input.owner,
      platform: input.platform,
      repoFullName: input.repoFullName,
      platformProjectId: input.platformProjectId,
      database,
    });
    return { event: inserted, created: true };
  }

  const [existing] = await database
    .select()
    .from(code_review_feedback_events)
    .where(eq(code_review_feedback_events.dedupe_hash, dedupeHash))
    .limit(1);

  if (!existing) {
    throw new Error('Failed to read deduped review memory feedback event');
  }

  await refreshAggregationStateForScope({
    owner: input.owner,
    platform: input.platform,
    repoFullName: input.repoFullName,
    platformProjectId: input.platformProjectId,
    database,
  });

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
  const cutoff = reviewMemoryRetentionCutoff(input.now);
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
      lastFreshEventCreatedAt: sql<string | null>`MAX(${code_review_feedback_events.created_at})`,
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
  const status: ReviewMemoryAggregationScopeStatus =
    existing?.status === 'running' ? 'running' : eventCount > 0 ? 'eligible' : 'idle';
  const now = new Date().toISOString();
  const stateValues = {
    fresh_event_count: eventCount,
    fresh_weight: rollup?.freshWeight ?? 0,
    fresh_distinct_subject_count: rollup?.distinctSubjectCount ?? 0,
    fresh_distinct_pr_count: rollup?.distinctPrCount ?? 0,
    last_included_event_created_at: rollup?.lastFreshEventCreatedAt ?? null,
    platform_project_id: input.platformProjectId ?? existing?.platform_project_id ?? null,
    status,
    updated_at: now,
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
      next_eligible_at: now,
    })
    .returning();

  if (!inserted) throw new Error('Failed to insert review memory aggregation state');
  return inserted;
}

export type PruneExpiredReviewMemoryDataSummary = {
  cutoff: string;
  proposalsDeleted: number;
  aggregationRunsDeleted: number;
  feedbackEventsDeleted: number;
  subjectsDeleted: number;
  aggregationStatesDeleted: number;
};

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
    database?: ReviewMemoryDatabase;
  } = {}
): Promise<PruneExpiredReviewMemoryDataSummary> {
  const database = databaseOrDefault(input.database);
  const now = input.now ?? new Date();
  const cutoff = reviewMemoryRetentionCutoff(now);
  const expiredEventScopes = await database
    .selectDistinct({
      ownedByOrganizationId: code_review_feedback_events.owned_by_organization_id,
      ownedByUserId: code_review_feedback_events.owned_by_user_id,
      platform: code_review_feedback_events.platform,
      repoFullName: code_review_feedback_events.repo_full_name,
      platformProjectId: code_review_feedback_events.platform_project_id,
    })
    .from(code_review_feedback_events)
    .where(lt(code_review_feedback_events.created_at, cutoff));

  const deletedProposals = await database
    .delete(code_review_memory_proposals)
    .where(lt(code_review_memory_proposals.created_at, cutoff))
    .returning({ id: code_review_memory_proposals.id });

  const deletedAggregationRuns = await database
    .delete(code_review_memory_aggregation_runs)
    .where(lt(code_review_memory_aggregation_runs.created_at, cutoff))
    .returning({ id: code_review_memory_aggregation_runs.id });

  const deletedFeedbackEvents = await database
    .delete(code_review_feedback_events)
    .where(lt(code_review_feedback_events.created_at, cutoff))
    .returning({ id: code_review_feedback_events.id });

  await refreshAggregationScopes({ scopes: expiredEventScopes, now, database });

  const deletedSubjects = await database
    .delete(code_review_feedback_subjects)
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
    .returning({ id: code_review_feedback_subjects.id });

  const deletedAggregationStates = await database
    .delete(code_review_memory_aggregation_state)
    .where(sql`NOT ${aggregationStateHasRetainedDataWhere(cutoff)}`)
    .returning({ id: code_review_memory_aggregation_state.id });

  return {
    cutoff,
    proposalsDeleted: deletedProposals.length,
    aggregationRunsDeleted: deletedAggregationRuns.length,
    feedbackEventsDeleted: deletedFeedbackEvents.length,
    subjectsDeleted: deletedSubjects.length,
    aggregationStatesDeleted: deletedAggregationStates.length,
  };
}

export type CreateAggregationRunInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  platformProjectId?: number | null;
  modelSlug: string;
  trigger: ReviewMemoryAggregationRunTrigger;
  inputEventCount?: number;
  inputSubjectCount?: number;
  inputClusterCount?: number;
  freshEventCutoffAt?: string | null;
  database?: ReviewMemoryDatabase;
};

export async function createAggregationRun(
  input: CreateAggregationRunInput
): Promise<CodeReviewMemoryAggregationRun> {
  const database = databaseOrDefault(input.database);
  const [run] = await database
    .insert(code_review_memory_aggregation_runs)
    .values({
      ...ownerColumns(input.owner),
      platform: input.platform,
      repo_full_name: input.repoFullName,
      platform_project_id: input.platformProjectId ?? null,
      model_slug: input.modelSlug,
      trigger: input.trigger,
      input_event_count: input.inputEventCount ?? 0,
      input_subject_count: input.inputSubjectCount ?? 0,
      input_cluster_count: input.inputClusterCount ?? 0,
      fresh_event_cutoff_at: input.freshEventCutoffAt ?? null,
      status: 'running',
    })
    .returning();

  if (!run) throw new Error('Failed to create review memory aggregation run');
  return run;
}

export async function updateAggregationRunStatus(input: {
  runId: string;
  status: ReviewMemoryAggregationRunStatus;
  skipReason?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  totalCostMusd?: number | null;
  errorMessage?: string | null;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryAggregationRun> {
  const database = databaseOrDefault(input.database);
  const updateValues: Partial<typeof code_review_memory_aggregation_runs.$inferInsert> = {
    status: input.status,
    skip_reason: input.skipReason ?? null,
    tokens_in: input.tokensIn ?? null,
    tokens_out: input.tokensOut ?? null,
    error_message: input.errorMessage ?? null,
    completed_at: input.status === 'running' ? null : new Date().toISOString(),
  };
  if (input.totalCostMusd !== undefined) {
    updateValues.total_cost_musd = input.totalCostMusd;
  }

  const [run] = await database
    .update(code_review_memory_aggregation_runs)
    .set(updateValues)
    .where(eq(code_review_memory_aggregation_runs.id, input.runId))
    .returning();

  if (!run) throw new Error('Failed to update review memory aggregation run');
  return run;
}

export type ClaimEligibleAggregationStatesInput = {
  limit?: number;
  stateId?: string;
  minFreshEvents: number;
  minFreshWeight: number;
  minDistinctSubjects: number;
  minDistinctPrs: number;
  staleAfterMs: number;
  now?: Date;
};

export async function claimEligibleAggregationStates(
  input: ClaimEligibleAggregationStatesInput
): Promise<CodeReviewMemoryAggregationState[]> {
  const now = input.now ?? new Date();
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
            status IN ('eligible', 'failed')
            AND next_eligible_at <= ${now.toISOString()}
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
      last_attempted_run_at = ${now.toISOString()},
      last_error_message = NULL,
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
  lastSuccessfulRunAt?: string | null;
  lastModelSlug?: string | null;
  lastErrorMessage?: string | null;
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
  if (input.lastSuccessfulRunAt !== undefined) {
    updateValues.last_successful_run_at = input.lastSuccessfulRunAt;
  }
  if (input.lastModelSlug !== undefined) {
    updateValues.last_model_slug = input.lastModelSlug;
  }
  if (input.lastErrorMessage !== undefined) {
    updateValues.last_error_message = input.lastErrorMessage;
  }

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
  platformIntegrationId?: string | null;
  repoFullName: string;
  platformProjectId?: number | null;
  aggregationRunId?: string | null;
  targetFilePath?: string;
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
  evidence?: { feedbackEventId: string; role: ReviewMemoryEvidenceRole }[];
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
    platform_integration_id: input.platformIntegrationId ?? null,
    platform_project_id: input.platformProjectId ?? null,
    aggregation_run_id: input.aggregationRunId ?? null,
    target_file_path: input.targetFilePath ?? 'REVIEW.md',
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

  if (input.evidence?.length) {
    await linkProposalEvidence({
      proposalId: proposal.id,
      evidence: input.evidence,
      database,
    });
  }

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

export async function linkProposalEvidence(input: {
  proposalId: string;
  evidence: { feedbackEventId: string; role: ReviewMemoryEvidenceRole }[];
  database?: ReviewMemoryDatabase;
}): Promise<void> {
  if (input.evidence.length === 0) return;
  const database = databaseOrDefault(input.database);
  await database
    .insert(code_review_memory_proposal_evidence)
    .values(
      input.evidence.map(item => ({
        proposal_id: input.proposalId,
        feedback_event_id: item.feedbackEventId,
        evidence_role: item.role,
      }))
    )
    .onConflictDoNothing();
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
  const stateColumns = getTableColumns(code_review_memory_aggregation_state);

  return await database
    .select({
      ...stateColumns,
      fresh_event_count: retainedFreshEventCountForAggregationState(cutoff),
      fresh_weight: retainedFreshEventWeightForAggregationState(cutoff),
      fresh_distinct_subject_count: retainedFreshEventSubjectCountForAggregationState(cutoff),
      fresh_distinct_pr_count: retainedFreshEventPrCountForAggregationState(cutoff),
      last_included_event_created_at: retainedLastFreshEventCreatedAtForAggregationState(cutoff),
    })
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

export async function listProposalEvidence(input: {
  proposalId: string;
  database?: ReviewMemoryDatabase;
}): Promise<
  {
    feedbackEvent: CodeReviewFeedbackEvent;
    subject: CodeReviewFeedbackSubject | null;
    role: ReviewMemoryEvidenceRole;
  }[]
> {
  const database = databaseOrDefault(input.database);
  const rows = await database
    .select({
      evidenceRole: code_review_memory_proposal_evidence.evidence_role,
      feedbackEvent: code_review_feedback_events,
      subject: code_review_feedback_subjects,
    })
    .from(code_review_memory_proposal_evidence)
    .innerJoin(
      code_review_feedback_events,
      eq(code_review_memory_proposal_evidence.feedback_event_id, code_review_feedback_events.id)
    )
    .leftJoin(
      code_review_feedback_subjects,
      eq(code_review_feedback_events.subject_id, code_review_feedback_subjects.id)
    )
    .where(
      and(
        eq(code_review_memory_proposal_evidence.proposal_id, input.proposalId),
        gte(code_review_feedback_events.created_at, reviewMemoryRetentionCutoff())
      )
    )
    .orderBy(desc(code_review_feedback_events.created_at));

  return rows.map(row => ({
    feedbackEvent: row.feedbackEvent,
    subject: row.subject,
    role: row.evidenceRole,
  }));
}

export async function updateReviewMemoryProposal(input: {
  owner: ReviewMemoryOwner;
  proposalId: string;
  editedByUserId: string;
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
      edited_by_user_id: input.editedByUserId,
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
  rejectedByUserId: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = databaseOrDefault(input.database);
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({
      status: 'rejected',
      rejected_by_user_id: input.rejectedByUserId,
      rejected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        proposalOwnerWhere(input.owner),
        eq(code_review_memory_proposals.id, input.proposalId),
        retainedProposalWhere()
      )
    )
    .returning();

  return proposal ?? null;
}

export async function markProposalOpeningChangeRequest(input: {
  owner: ReviewMemoryOwner;
  proposalId: string;
  approvedByUserId: string;
  changeRequestType: ReviewMemoryChangeRequestType;
  branchName: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = databaseOrDefault(input.database);
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({
      status: 'opening_change_request',
      approved_by_user_id: input.approvedByUserId,
      approved_at: new Date().toISOString(),
      change_request_type: input.changeRequestType,
      branch_name: input.branchName,
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
  changeRequestNumber: number;
  changeRequestUrl: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal> {
  const database = databaseOrDefault(input.database);
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({
      status: 'change_request_opened',
      change_request_number: input.changeRequestNumber,
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
