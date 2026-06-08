import { isReviewMemoryEnabled } from './settings';
import { captureException } from '@sentry/nextjs';
import { generateText } from 'ai';
import * as z from 'zod';
import type {
  CodeReviewFeedbackEvent,
  CodeReviewFeedbackSubject,
  CodeReviewMemoryAggregationState,
} from '@kilocode/db/schema';
import type {
  ReviewMemoryPlatform,
  ReviewMemoryProposalScopeKind,
  ReviewMemoryProposalType,
} from '@kilocode/db/schema-types';
import {
  claimEligibleAggregationStates,
  finishClaimedAggregationState,
  listFeedbackEventsForAggregation,
  listReviewMemoryProposals,
  markFeedbackEventsAggregationState,
  markFeedbackEventsIncluded,
  refreshAggregationStateForScope,
  upsertReviewMemoryProposal,
  type ReviewMemoryOwner,
} from './db';
import {
  createReviewMemoryGatewayProvider,
  extractReviewMemoryJsonObject,
  resolveReviewMemoryActor,
  resolveReviewMemoryModel,
} from './llm';

export const REVIEW_MEMORY_AGGREGATION_THRESHOLDS = {
  minFreshEvents: 5,
  minFreshWeight: 8,
  minDistinctSubjects: 3,
  minDistinctPrs: 2,
  cooldownMs: 20 * 60 * 60 * 1000,
  failureRetryMs: 60 * 60 * 1000,
  staleClaimMs: 30 * 60 * 1000,
  maxEventsPerScope: 200,
  maxClustersPerRun: 20,
} as const;

const WeakPullRequestSignals = new Set([
  'mr_approved',
  'mr_unapproved',
  'pr_approved',
  'pr_changes_requested',
]);

const AggregationOpportunitySchema = z.object({
  title: z.string().min(1).max(140),
  proposalType: z.enum(['suppress', 'clarify', 'narrow', 'reinforce']),
  scopeKind: z.enum(['repository', 'path_glob', 'file', 'language']),
  scopeValue: z.string().nullable(),
  rationale: z.string().min(1).max(1_500),
  proposedMarkdown: z.string().min(1).max(4_000),
  confidence: z.enum(['low', 'medium', 'high']),
  evidenceEventIds: z.array(z.string()).max(20),
  contradictoryEventIds: z.array(z.string()).max(20).default([]),
  dedupeHint: z.string().min(1).max(200),
});

const AggregationOutputSchema = z.object({
  opportunities: z.array(AggregationOpportunitySchema).max(10),
});

export type ReviewMemoryAggregationOpportunity = z.infer<typeof AggregationOpportunitySchema>;

type FeedbackEventForAggregation = CodeReviewFeedbackEvent & {
  subject: CodeReviewFeedbackSubject | null;
};

type FeedbackCluster = {
  id: string;
  title: string;
  eventIds: string[];
  positiveCount: number;
  negativeCount: number;
  neutralCount: number;
  weight: number;
  distinctPrs: number;
  distinctSubjects: number;
  samples: string[];
};

export type ReviewMemoryAggregationGeneratorInput = {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  modelSlug: string;
  prompt: string;
  clusters: FeedbackCluster[];
};

export type ReviewMemoryAggregationGeneratorResult = {
  opportunities: ReviewMemoryAggregationOpportunity[];
  tokensIn?: number | null;
  tokensOut?: number | null;
};

export type DispatchReviewMemoryAggregationSummary = {
  claimed: number;
  completed: number;
  skipped: number;
  failed: number;
  proposals: number;
};

type ProcessAggregationScopeResult = {
  status: 'completed' | 'skipped' | 'failed';
  proposals: number;
  reason?: string;
};

export type DispatchReviewMemoryAggregationOptions = {
  limit?: number;
  stateId?: string;
  bypassEligibleCooldown?: boolean;
  now?: Date;
  generateOpportunities?: (
    input: ReviewMemoryAggregationGeneratorInput
  ) => Promise<ReviewMemoryAggregationGeneratorResult>;
};

function ownerFromState(state: CodeReviewMemoryAggregationState): ReviewMemoryOwner | null {
  if (state.owned_by_organization_id) {
    return { type: 'org', id: state.owned_by_organization_id };
  }
  if (state.owned_by_user_id) {
    return { type: 'user', id: state.owned_by_user_id };
  }
  return null;
}

function createDedupeKey(input: {
  repoFullName: string;
  proposalType: ReviewMemoryProposalType;
  scopeKind: ReviewMemoryProposalScopeKind;
  scopeValue: string | null;
  dedupeHint: string;
}): string {
  return [
    input.repoFullName.toLowerCase(),
    input.proposalType,
    input.scopeKind,
    input.scopeValue?.toLowerCase() ?? 'repository',
    input.dedupeHint.toLowerCase().replace(/\s+/g, ' ').trim(),
  ].join(':');
}

function addMs(date: Date, ms: number): string {
  return new Date(date.getTime() + ms).toISOString();
}

function hasActionableCommentEvidence(events: FeedbackEventForAggregation[]): boolean {
  return events.some(event => event.subject && !WeakPullRequestSignals.has(event.signal_kind));
}

function clusterKey(event: FeedbackEventForAggregation): string {
  const subject = event.subject;
  if (subject?.finding_fingerprint) return `finding:${subject.finding_fingerprint}`;
  if (subject?.file_path) return `file:${subject.file_path}:${event.signal_kind}`;
  if (subject?.subject_type) return `subject:${subject.subject_type}:${event.signal_kind}`;
  return `signal:${event.signal_kind}`;
}

function clusterTitle(event: FeedbackEventForAggregation): string {
  if (event.subject?.finding_title) return event.subject.finding_title;
  if (event.subject?.file_path) return `${event.signal_kind} in ${event.subject.file_path}`;
  return event.signal_kind.replace(/_/g, ' ');
}

export function buildFeedbackClusters(
  events: FeedbackEventForAggregation[],
  maxClusters = REVIEW_MEMORY_AGGREGATION_THRESHOLDS.maxClustersPerRun
): FeedbackCluster[] {
  const clusters = new Map<string, FeedbackCluster>();
  for (const event of events) {
    const key = clusterKey(event);
    const existing = clusters.get(key);
    const cluster =
      existing ??
      ({
        id: key,
        title: clusterTitle(event),
        eventIds: [],
        positiveCount: 0,
        negativeCount: 0,
        neutralCount: 0,
        weight: 0,
        distinctPrs: 0,
        distinctSubjects: 0,
        samples: [],
      } satisfies FeedbackCluster);

    cluster.eventIds.push(event.id);
    cluster.weight += event.strength;
    if (event.sentiment === 'positive') cluster.positiveCount += 1;
    if (event.sentiment === 'negative') cluster.negativeCount += 1;
    if (event.sentiment === 'neutral') cluster.neutralCount += 1;
    if (cluster.samples.length < 6 && event.evidence_excerpt) {
      cluster.samples.push(event.evidence_excerpt);
    }
    clusters.set(key, cluster);
  }

  const distinctPrsByCluster = new Map<string, Set<number>>();
  const distinctSubjectsByCluster = new Map<string, Set<string>>();
  for (const event of events) {
    const key = clusterKey(event);
    if (event.pr_number != null) {
      const prs = distinctPrsByCluster.get(key) ?? new Set<number>();
      prs.add(event.pr_number);
      distinctPrsByCluster.set(key, prs);
    }
    if (event.subject_id) {
      const subjects = distinctSubjectsByCluster.get(key) ?? new Set<string>();
      subjects.add(event.subject_id);
      distinctSubjectsByCluster.set(key, subjects);
    }
  }

  for (const [key, cluster] of clusters) {
    cluster.distinctPrs = distinctPrsByCluster.get(key)?.size ?? 0;
    cluster.distinctSubjects = distinctSubjectsByCluster.get(key)?.size ?? 0;
  }

  return [...clusters.values()]
    .sort((a, b) => b.weight - a.weight || b.eventIds.length - a.eventIds.length)
    .slice(0, maxClusters);
}

function buildAggregationPrompt(input: {
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  clusters: FeedbackCluster[];
  existingProposalSummaries: string[];
}): string {
  return `You analyze maintainer feedback about Kilo Code Review output and draft REVIEW.md improvement opportunities.

Return strict JSON with this shape:
{"opportunities":[{"title":"...","proposalType":"suppress|clarify|narrow|reinforce","scopeKind":"repository|path_glob|file|language","scopeValue":null,"rationale":"...","proposedMarkdown":"...","confidence":"low|medium|high","evidenceEventIds":["..."],"contradictoryEventIds":[],"dedupeHint":"..."}]}

Rules:
- Do not create proposals from isolated weak PR/MR-level signals.
- Negative feedback should produce suppress, clarify, or narrow guidance.
- Positive feedback should produce reinforce guidance.
- Draft markdown as candidate repository guidance, not as a final file placement.
- Do not mention Review Memory or Kilo Review Memory.
- Do not create a catch-all Review Memory section.
- Include enough concrete wording that a later integration step can merge it into REVIEW.md.
- Use only evidenceEventIds from the provided clusters.
- If feedback is too weak or contradictory, return an empty opportunities array.

Platform: ${input.platform}
Repository: ${input.repoFullName}

Existing active proposals:
${input.existingProposalSummaries.length ? input.existingProposalSummaries.join('\n') : 'None'}

Feedback clusters:
${JSON.stringify(input.clusters, null, 2)}`;
}

export async function generateReviewMemoryOpportunitiesWithGateway(
  input: ReviewMemoryAggregationGeneratorInput
): Promise<ReviewMemoryAggregationGeneratorResult> {
  const actor = await resolveReviewMemoryActor(input.owner);
  const provider = createReviewMemoryGatewayProvider({
    owner: input.owner,
    actor,
    userAgent: 'Kilo Review Memory Aggregator',
  });
  const result = await generateText({
    model: provider.chatModel(input.modelSlug),
    prompt: input.prompt,
    maxOutputTokens: 4_000,
  });
  const parsed = AggregationOutputSchema.parse(extractReviewMemoryJsonObject(result.text));

  return {
    opportunities: parsed.opportunities,
    tokensIn: result.usage.inputTokens ?? null,
    tokensOut: result.usage.outputTokens ?? null,
  };
}

function proposalRollups(
  opportunity: ReviewMemoryAggregationOpportunity,
  eventById: Map<string, FeedbackEventForAggregation>
) {
  const evidenceIds = opportunity.evidenceEventIds.filter(id => eventById.has(id));
  const contradictoryIds = opportunity.contradictoryEventIds.filter(id => eventById.has(id));
  const allIds = [...new Set([...evidenceIds, ...contradictoryIds])];
  const events = allIds.map(id => eventById.get(id)).filter(event => event != null);

  return {
    evidenceIds,
    positiveCount: events.filter(event => event.sentiment === 'positive').length,
    negativeCount: events.filter(event => event.sentiment === 'negative').length,
    neutralCount: events.filter(event => event.sentiment === 'neutral').length,
  };
}

async function processClaimedAggregationScope(
  state: CodeReviewMemoryAggregationState,
  options: Required<Pick<DispatchReviewMemoryAggregationOptions, 'now' | 'generateOpportunities'>>
): Promise<ProcessAggregationScopeResult> {
  const owner = ownerFromState(state);
  if (!owner || !state.claim_token) {
    return { status: 'failed', proposals: 0, reason: 'missing-owner-or-claim' };
  }

  if (!(await isReviewMemoryEnabled({ owner, platform: state.platform }))) {
    await finishClaimedAggregationState({
      stateId: state.id,
      claimToken: state.claim_token,
      status: 'idle',
      nextEligibleAt: addMs(options.now, REVIEW_MEMORY_AGGREGATION_THRESHOLDS.cooldownMs),
    });
    return { status: 'skipped', proposals: 0, reason: 'review-memory-disabled' };
  }

  const { modelSlug } = await resolveReviewMemoryModel({ owner, platform: state.platform });
  const events = await listFeedbackEventsForAggregation({
    owner,
    platform: state.platform,
    repoFullName: state.repo_full_name,
    limit: REVIEW_MEMORY_AGGREGATION_THRESHOLDS.maxEventsPerScope,
  });
  const clusters = buildFeedbackClusters(events);

  try {
    if (events.length === 0 || !hasActionableCommentEvidence(events) || clusters.length === 0) {
      await markFeedbackEventsAggregationState({
        eventIds: events.map(event => event.id),
        aggregationState: 'ignored',
      });
      await finishClaimedAggregationState({
        stateId: state.id,
        claimToken: state.claim_token,
        status: 'idle',
        nextEligibleAt: addMs(options.now, REVIEW_MEMORY_AGGREGATION_THRESHOLDS.cooldownMs),
      });
      await refreshAggregationStateForScope({
        owner,
        platform: state.platform,
        repoFullName: state.repo_full_name,
        platformProjectId: state.platform_project_id,
        now: options.now,
      });
      return { status: 'skipped', proposals: 0, reason: 'no_actionable_comment_evidence' };
    }

    const existingProposals = await listReviewMemoryProposals({
      owner,
      platform: state.platform,
      repoFullName: state.repo_full_name,
      statuses: ['open', 'edited', 'approved', 'opening_change_request', 'change_request_opened'],
      limit: 20,
    });
    const prompt = buildAggregationPrompt({
      platform: state.platform,
      repoFullName: state.repo_full_name,
      clusters,
      existingProposalSummaries: existingProposals.map(
        proposal => `- ${proposal.title} (${proposal.proposal_type}, ${proposal.scope_kind})`
      ),
    });
    const eventById = new Map(events.map(event => [event.id, event]));
    const processedEventIds = [...new Set(clusters.flatMap(cluster => cluster.eventIds))];
    const generation = await options.generateOpportunities({
      owner,
      platform: state.platform,
      repoFullName: state.repo_full_name,
      modelSlug,
      prompt,
      clusters,
    });

    let proposalCount = 0;
    for (const opportunity of generation.opportunities) {
      const rollups = proposalRollups(opportunity, eventById);
      if (rollups.evidenceIds.length === 0) continue;
      await upsertReviewMemoryProposal({
        owner,
        platform: state.platform,
        repoFullName: state.repo_full_name,
        platformProjectId: state.platform_project_id,
        scopeKind: opportunity.scopeKind,
        scopeValue: opportunity.scopeValue,
        proposalType: opportunity.proposalType,
        title: opportunity.title,
        rationale: opportunity.rationale,
        proposedMarkdown: opportunity.proposedMarkdown,
        dedupeKey: createDedupeKey({
          repoFullName: state.repo_full_name,
          proposalType: opportunity.proposalType,
          scopeKind: opportunity.scopeKind,
          scopeValue: opportunity.scopeValue,
          dedupeHint: opportunity.dedupeHint,
        }),
        positiveCount: rollups.positiveCount,
        negativeCount: rollups.negativeCount,
        neutralCount: rollups.neutralCount,
      });
      proposalCount += 1;
    }

    await markFeedbackEventsIncluded({ eventIds: processedEventIds });
    await finishClaimedAggregationState({
      stateId: state.id,
      claimToken: state.claim_token,
      status: 'idle',
      nextEligibleAt: addMs(options.now, REVIEW_MEMORY_AGGREGATION_THRESHOLDS.cooldownMs),
    });
    await refreshAggregationStateForScope({
      owner,
      platform: state.platform,
      repoFullName: state.repo_full_name,
      platformProjectId: state.platform_project_id,
      now: options.now,
    });

    return { status: 'completed', proposals: proposalCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishClaimedAggregationState({
      stateId: state.id,
      claimToken: state.claim_token,
      status: 'failed',
      nextEligibleAt: addMs(options.now, REVIEW_MEMORY_AGGREGATION_THRESHOLDS.failureRetryMs),
    });
    captureException(error, {
      tags: { source: 'review-memory-aggregation' },
      extra: { stateId: state.id, repoFullName: state.repo_full_name, platform: state.platform },
    });
    return { status: 'failed', proposals: 0, reason: message };
  }
}

export async function dispatchManualReviewMemoryAggregation(
  options: DispatchReviewMemoryAggregationOptions = {}
): Promise<DispatchReviewMemoryAggregationSummary> {
  const now = options.now ?? new Date();
  const generateOpportunities =
    options.generateOpportunities ?? generateReviewMemoryOpportunitiesWithGateway;
  const claimed = await claimEligibleAggregationStates({
    limit: options.limit ?? 10,
    stateId: options.stateId,
    minFreshEvents: REVIEW_MEMORY_AGGREGATION_THRESHOLDS.minFreshEvents,
    minFreshWeight: REVIEW_MEMORY_AGGREGATION_THRESHOLDS.minFreshWeight,
    minDistinctSubjects: REVIEW_MEMORY_AGGREGATION_THRESHOLDS.minDistinctSubjects,
    minDistinctPrs: REVIEW_MEMORY_AGGREGATION_THRESHOLDS.minDistinctPrs,
    staleAfterMs: REVIEW_MEMORY_AGGREGATION_THRESHOLDS.staleClaimMs,
    bypassEligibleCooldown: options.bypassEligibleCooldown,
    now,
  });

  const summary: DispatchReviewMemoryAggregationSummary = {
    claimed: claimed.length,
    completed: 0,
    skipped: 0,
    failed: 0,
    proposals: 0,
  };

  for (const state of claimed) {
    const result = await processClaimedAggregationScope(state, { now, generateOpportunities });
    summary.proposals += result.proposals;
    if (result.status === 'completed') summary.completed += 1;
    if (result.status === 'skipped') summary.skipped += 1;
    if (result.status === 'failed') summary.failed += 1;
  }

  return summary;
}
