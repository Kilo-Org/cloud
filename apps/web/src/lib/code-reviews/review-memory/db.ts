import { createHash } from 'crypto';
import { and, asc, count, desc, eq, gte, inArray, lt, or, type SQL } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';

import { db } from '@/lib/drizzle';
import {
  code_review_feedback_events,
  code_review_memory_proposals,
  type CodeReviewFeedbackEvent,
  type CodeReviewMemoryProposal,
} from '@kilocode/db/schema';
import type {
  ReviewMemoryEvidenceItem,
  ReviewMemoryPlatform,
  ReviewMemoryProposalStatus,
} from '@kilocode/db/schema-types';
import { reviewMemoryRetentionCutoff } from './retention';

export type ReviewMemoryOwner = { type: 'org'; id: string } | { type: 'user'; id: string };
export type ReviewMemoryDatabase = typeof db;

const ACTIVE_PROPOSAL_STATUSES = [
  'open',
  'edited',
  'opening_change_request',
  'change_request_failed',
] as const;
const EDITABLE_PROPOSAL_STATUSES = ['open', 'edited', 'change_request_failed'] as const;
const TERMINAL_PRUNABLE_PROPOSAL_STATUSES = [
  'rejected',
  'change_request_opened',
  'superseded',
] as const;
const REVIEW_MEMORY_PRUNE_BATCH_SIZE = 1_000;

export function createReviewMemoryDedupeHash(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export async function recordReplyFeedbackEvent(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  prNumber?: number | null;
  kiloCommentId: string;
  replyExcerpt: string;
  kiloCommentExcerpt?: string | null;
  occurredAt?: string | null;
  database?: ReviewMemoryDatabase;
}): Promise<{ event: CodeReviewFeedbackEvent; created: boolean }> {
  const database = input.database ?? db;
  const dedupeHash = createReviewMemoryDedupeHash([
    input.platform,
    input.owner.type,
    input.owner.id,
    input.kiloCommentId,
  ]);
  const [inserted] = await database
    .insert(code_review_feedback_events)
    .values({
      ...ownerInsertValues(input.owner),
      platform: input.platform,
      repo_full_name: input.repoFullName,
      pr_number: input.prNumber ?? null,
      kilo_comment_id: input.kiloCommentId,
      reply_excerpt: input.replyExcerpt,
      kilo_comment_excerpt: input.kiloCommentExcerpt ?? null,
      dedupe_hash: dedupeHash,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
    })
    .onConflictDoNothing({ target: code_review_feedback_events.dedupe_hash })
    .returning();

  if (inserted) return { event: inserted, created: true };

  const [existing] = await database
    .select()
    .from(code_review_feedback_events)
    .where(eq(code_review_feedback_events.dedupe_hash, dedupeHash))
    .limit(1);
  if (!existing) throw new Error('Review Memory feedback dedupe lookup failed');
  return { event: existing, created: false };
}

export async function listRecentFeedbackEvents(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  since?: string;
  limit?: number;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewFeedbackEvent[]> {
  const database = input.database ?? db;
  const limit = Math.min(input.limit ?? 200, 500);
  return await database
    .select()
    .from(code_review_feedback_events)
    .where(
      and(
        ...feedbackOwnerConditions(input.owner),
        eq(code_review_feedback_events.platform, input.platform),
        eq(code_review_feedback_events.repo_full_name, input.repoFullName),
        gte(code_review_feedback_events.created_at, input.since ?? reviewMemoryRetentionCutoff())
      )
    )
    .orderBy(desc(code_review_feedback_events.created_at))
    .limit(limit);
}

export async function listRepositoriesWithRecentFeedback(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  database?: ReviewMemoryDatabase;
}): Promise<{ repoFullName: string; feedbackCount: number }[]> {
  const database = input.database ?? db;
  return await database
    .select({
      repoFullName: code_review_feedback_events.repo_full_name,
      feedbackCount: count(),
    })
    .from(code_review_feedback_events)
    .where(
      and(
        ...feedbackOwnerConditions(input.owner),
        eq(code_review_feedback_events.platform, input.platform),
        gte(code_review_feedback_events.created_at, reviewMemoryRetentionCutoff())
      )
    )
    .groupBy(code_review_feedback_events.repo_full_name)
    .orderBy(desc(count()));
}

export async function getActiveProposalForScope(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = input.database ?? db;
  const [proposal] = await database
    .select()
    .from(code_review_memory_proposals)
    .where(
      and(
        ...proposalOwnerConditions(input.owner),
        eq(code_review_memory_proposals.platform, input.platform),
        eq(code_review_memory_proposals.repo_full_name, input.repoFullName),
        inArray(code_review_memory_proposals.status, [...ACTIVE_PROPOSAL_STATUSES])
      )
    )
    .limit(1);
  return proposal ?? null;
}

export async function upsertScopeProposal(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  title: string;
  rationale: string;
  proposedMarkdown: string;
  evidence: ReviewMemoryEvidenceItem[];
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal> {
  const database = input.database ?? db;
  const existing = await getActiveProposalForScope({
    owner: input.owner,
    platform: input.platform,
    repoFullName: input.repoFullName,
    database,
  });
  const now = new Date().toISOString();

  if (existing) {
    const [updated] = await database
      .update(code_review_memory_proposals)
      .set({
        status: existing.status === 'opening_change_request' ? existing.status : 'open',
        title: input.title,
        rationale: input.rationale,
        proposed_markdown: input.proposedMarkdown,
        evidence: input.evidence,
        positive_count: input.positiveCount,
        negative_count: input.negativeCount,
        neutral_count: input.neutralCount,
        updated_at: now,
      })
      .where(eq(code_review_memory_proposals.id, existing.id))
      .returning();
    if (!updated) throw new Error('Review Memory active proposal update failed');
    return updated;
  }

  const [inserted] = await database
    .insert(code_review_memory_proposals)
    .values({
      ...ownerInsertValues(input.owner),
      platform: input.platform,
      repo_full_name: input.repoFullName,
      title: input.title,
      rationale: input.rationale,
      proposed_markdown: input.proposedMarkdown,
      evidence: input.evidence,
      positive_count: input.positiveCount,
      negative_count: input.negativeCount,
      neutral_count: input.neutralCount,
    })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    const conflicted = await getActiveProposalForScope({
      owner: input.owner,
      platform: input.platform,
      repoFullName: input.repoFullName,
      database,
    });
    if (conflicted) return conflicted;
    throw new Error('Review Memory active proposal conflict lookup failed');
  }
  return inserted;
}

export type ReviewMemoryProposalPage = {
  proposals: CodeReviewMemoryProposal[];
  nextCursor: string | null;
};

const PROPOSAL_CURSOR_SEPARATOR = '|';
const PROPOSAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keyset pagination cursor for `listProposalsPage`. The list orders by
// `updated_at` desc with `id` desc as the deterministic tie-breaker, so the
// cursor encodes the last row's `(updated_at, id)`. `updated_at` is a
// PostgreSQL timestamptz returned as text with microsecond precision (e.g.
// "2026-04-29 01:16:12.945123+00"). The cursor is opaque and only compared
// against the database column, never parsed by a client, so it carries the
// raw value verbatim — normalizing through `new Date(...).toISOString()` would
// truncate microseconds and silently skip rows that share a millisecond.
function encodeProposalCursor(row: CodeReviewMemoryProposal): string {
  return `${row.updated_at}${PROPOSAL_CURSOR_SEPARATOR}${row.id}`;
}

function decodeProposalCursor(cursor: string): { updatedAt: string; id: string } | null {
  const separatorIndex = cursor.indexOf(PROPOSAL_CURSOR_SEPARATOR);
  if (separatorIndex <= 0) return null;
  const updatedAt = cursor.slice(0, separatorIndex);
  const id = cursor.slice(separatorIndex + 1);
  if (!PROPOSAL_ID_PATTERN.test(id)) return null;
  if (Number.isNaN(new Date(updatedAt).getTime())) return null;
  return { updatedAt, id };
}

// Compatibility: the array-shaped `listProposals` is the deployed contract
// (`origin/main` returns `CodeReviewMemoryProposal[]`); the web panel and
// stale client bundles call it. Keep it, and serve the paginated shape
// through the additive `listProposalsPage`.
export async function listProposals(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName?: string;
  statuses?: ReviewMemoryProposalStatus[];
  limit?: number;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal[]> {
  const page = await listProposalsPage(input);
  return page.proposals;
}

export async function listProposalsPage(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName?: string;
  statuses?: ReviewMemoryProposalStatus[];
  limit?: number;
  cursor?: string;
  database?: ReviewMemoryDatabase;
}): Promise<ReviewMemoryProposalPage> {
  const database = input.database ?? db;
  const limit = Math.min(input.limit ?? 50, 100);
  const conditions: SQL[] = [
    ...proposalOwnerConditions(input.owner),
    eq(code_review_memory_proposals.platform, input.platform),
  ];
  if (input.repoFullName) {
    conditions.push(eq(code_review_memory_proposals.repo_full_name, input.repoFullName));
  }
  if (input.statuses && input.statuses.length > 0) {
    conditions.push(inArray(code_review_memory_proposals.status, input.statuses));
  }
  if (input.cursor) {
    const cursor = decodeProposalCursor(input.cursor);
    if (!cursor) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Invalid Review Memory proposal cursor.',
      });
    }
    const sameTimestamp = and(
      eq(code_review_memory_proposals.updated_at, cursor.updatedAt),
      lt(code_review_memory_proposals.id, cursor.id)
    );
    const cursorPredicate = or(
      lt(code_review_memory_proposals.updated_at, cursor.updatedAt),
      sameTimestamp
    );
    if (cursorPredicate) conditions.push(cursorPredicate);
  }

  const rows = await database
    .select()
    .from(code_review_memory_proposals)
    .where(and(...conditions))
    .orderBy(desc(code_review_memory_proposals.updated_at), desc(code_review_memory_proposals.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const proposals = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor =
    hasMore && proposals.length > 0 ? encodeProposalCursor(proposals[proposals.length - 1]) : null;

  return { proposals, nextCursor };
}

export async function getProposal(input: {
  owner: ReviewMemoryOwner;
  proposalId: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = input.database ?? db;
  const [proposal] = await database
    .select()
    .from(code_review_memory_proposals)
    .where(
      and(
        ...proposalOwnerConditions(input.owner),
        eq(code_review_memory_proposals.id, input.proposalId)
      )
    )
    .limit(1);
  return proposal ?? null;
}

export async function updateProposal(input: {
  owner: ReviewMemoryOwner;
  proposalId: string;
  title: string;
  rationale: string;
  proposedMarkdown: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = input.database ?? db;
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({
      title: input.title,
      rationale: input.rationale,
      proposed_markdown: input.proposedMarkdown,
      status: 'edited',
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        ...proposalOwnerConditions(input.owner),
        eq(code_review_memory_proposals.id, input.proposalId),
        inArray(code_review_memory_proposals.status, [...EDITABLE_PROPOSAL_STATUSES])
      )
    )
    .returning();
  return proposal ?? null;
}

export async function rejectProposal(input: {
  owner: ReviewMemoryOwner;
  proposalId: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = input.database ?? db;
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({ status: 'rejected', updated_at: new Date().toISOString() })
    .where(
      and(
        ...proposalOwnerConditions(input.owner),
        eq(code_review_memory_proposals.id, input.proposalId),
        inArray(code_review_memory_proposals.status, [...EDITABLE_PROPOSAL_STATUSES])
      )
    )
    .returning();
  return proposal ?? null;
}

export async function markProposalOpeningChangeRequest(input: {
  proposalId: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  return await markProposalStatus({
    proposalId: input.proposalId,
    fromStatuses: [...EDITABLE_PROPOSAL_STATUSES],
    set: { status: 'opening_change_request', change_request_url: null },
    database: input.database,
  });
}

export async function markProposalChangeRequestOpened(input: {
  proposalId: string;
  changeRequestUrl: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  return await markProposalStatus({
    proposalId: input.proposalId,
    fromStatuses: ['opening_change_request'],
    set: { status: 'change_request_opened', change_request_url: input.changeRequestUrl },
    database: input.database,
  });
}

export async function markProposalChangeRequestFailed(input: {
  proposalId: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  return await markProposalStatus({
    proposalId: input.proposalId,
    fromStatuses: ['opening_change_request'],
    set: { status: 'change_request_failed' },
    database: input.database,
  });
}

export async function markProposalSuperseded(input: {
  proposalId: string;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  return await markProposalStatus({
    proposalId: input.proposalId,
    fromStatuses: ['open', 'edited', 'opening_change_request', 'change_request_failed'],
    set: { status: 'superseded' },
    database: input.database,
  });
}

export async function countActiveProposals(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName?: string;
  database?: ReviewMemoryDatabase;
}): Promise<number> {
  const database = input.database ?? db;
  const conditions: SQL[] = [
    ...proposalOwnerConditions(input.owner),
    eq(code_review_memory_proposals.platform, input.platform),
    inArray(code_review_memory_proposals.status, [...ACTIVE_PROPOSAL_STATUSES]),
  ];
  if (input.repoFullName) {
    conditions.push(eq(code_review_memory_proposals.repo_full_name, input.repoFullName));
  }

  const [row] = await database
    .select({ value: count() })
    .from(code_review_memory_proposals)
    .where(and(...conditions));
  return row?.value ?? 0;
}

export async function pruneExpiredReviewMemoryData(input?: {
  now?: Date;
  database?: ReviewMemoryDatabase;
}): Promise<{ cutoff: string; feedbackEventsDeleted: number; proposalsDeleted: number }> {
  const database = input?.database ?? db;
  const cutoff = reviewMemoryRetentionCutoff(input?.now);
  const feedbackEvents = await database
    .select({ id: code_review_feedback_events.id })
    .from(code_review_feedback_events)
    .where(lt(code_review_feedback_events.created_at, cutoff))
    .orderBy(asc(code_review_feedback_events.created_at))
    .limit(REVIEW_MEMORY_PRUNE_BATCH_SIZE);
  const feedbackEventIds = feedbackEvents.map(event => event.id);
  const feedbackResult =
    feedbackEventIds.length > 0
      ? await database
          .delete(code_review_feedback_events)
          .where(inArray(code_review_feedback_events.id, feedbackEventIds))
      : null;

  const proposals = await database
    .select({ id: code_review_memory_proposals.id })
    .from(code_review_memory_proposals)
    .where(
      and(
        lt(code_review_memory_proposals.updated_at, cutoff),
        inArray(code_review_memory_proposals.status, [...TERMINAL_PRUNABLE_PROPOSAL_STATUSES])
      )
    )
    .orderBy(asc(code_review_memory_proposals.updated_at))
    .limit(REVIEW_MEMORY_PRUNE_BATCH_SIZE);
  const proposalIds = proposals.map(proposal => proposal.id);
  const proposalResult =
    proposalIds.length > 0
      ? await database
          .delete(code_review_memory_proposals)
          .where(inArray(code_review_memory_proposals.id, proposalIds))
      : null;

  return {
    cutoff,
    feedbackEventsDeleted: feedbackResult?.rowCount ?? 0,
    proposalsDeleted: proposalResult?.rowCount ?? 0,
  };
}

function ownerInsertValues(owner: ReviewMemoryOwner) {
  return owner.type === 'org'
    ? { owned_by_organization_id: owner.id, owned_by_user_id: null }
    : { owned_by_organization_id: null, owned_by_user_id: owner.id };
}

function feedbackOwnerConditions(owner: ReviewMemoryOwner): SQL[] {
  return owner.type === 'org'
    ? [eq(code_review_feedback_events.owned_by_organization_id, owner.id)]
    : [eq(code_review_feedback_events.owned_by_user_id, owner.id)];
}

function proposalOwnerConditions(owner: ReviewMemoryOwner): SQL[] {
  return owner.type === 'org'
    ? [eq(code_review_memory_proposals.owned_by_organization_id, owner.id)]
    : [eq(code_review_memory_proposals.owned_by_user_id, owner.id)];
}

async function markProposalStatus(input: {
  proposalId: string;
  fromStatuses: ReviewMemoryProposalStatus[];
  set: Partial<typeof code_review_memory_proposals.$inferInsert>;
  database?: ReviewMemoryDatabase;
}): Promise<CodeReviewMemoryProposal | null> {
  const database = input.database ?? db;
  const [proposal] = await database
    .update(code_review_memory_proposals)
    .set({ ...input.set, updated_at: new Date().toISOString() })
    .where(
      and(
        eq(code_review_memory_proposals.id, input.proposalId),
        inArray(code_review_memory_proposals.status, input.fromStatuses)
      )
    )
    .returning();
  return proposal ?? null;
}
