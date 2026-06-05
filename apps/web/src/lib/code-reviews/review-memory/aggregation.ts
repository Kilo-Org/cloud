import { APP_URL } from '@/lib/constants';
import { DEFAULT_CODE_REVIEW_MODEL } from '@/lib/code-reviews/core/constants';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import {
  CodeReviewAgentConfigSchema,
  type CodeReviewAgentConfig,
} from '@/lib/agent-config/core/types';
import { FEATURE_HEADER } from '@/lib/feature-detection';
import { ensureBotUserForOrg } from '@/lib/bot-users/bot-user-service';
import { findUserById } from '@/lib/user';
import { generateApiToken } from '@/lib/tokens';
import { captureException } from '@sentry/nextjs';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import * as z from 'zod';
import type {
  CodeReviewFeedbackEvent,
  CodeReviewFeedbackSubject,
  CodeReviewMemoryAggregationState,
  User,
} from '@kilocode/db/schema';
import type {
  ReviewMemoryPlatform,
  ReviewMemoryProposalScopeKind,
  ReviewMemoryProposalType,
} from '@kilocode/db/schema-types';
import {
  claimEligibleAggregationStates,
  createAggregationRun,
  finishClaimedAggregationState,
  listFeedbackEventsForAggregation,
  listReviewMemoryProposals,
  markFeedbackEventsAggregationState,
  markFeedbackEventsIncluded,
  refreshAggregationStateForScope,
  updateAggregationRunStatus,
  upsertReviewMemoryProposal,
  type ReviewMemoryOwner,
} from './db';
import { isReviewMemoryEnabled } from './settings';

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

function confidenceToScore(confidence: ReviewMemoryAggregationOpportunity['confidence']): number {
  if (confidence === 'high') return 0.9;
  if (confidence === 'medium') return 0.66;
  return 0.33;
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
- Draft concise REVIEW.md markdown with a heading, scope, guidance, and why.
- Use only evidenceEventIds from the provided clusters.
- If feedback is too weak or contradictory, return an empty opportunities array.

Platform: ${input.platform}
Repository: ${input.repoFullName}

Existing active proposals:
${input.existingProposalSummaries.length ? input.existingProposalSummaries.join('\n') : 'None'}

Feedback clusters:
${JSON.stringify(input.clusters, null, 2)}`;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return JSON.parse(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1]);
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('Aggregation model did not return JSON');
}

async function resolveAggregationActor(owner: ReviewMemoryOwner): Promise<User> {
  if (owner.type === 'org') {
    return await ensureBotUserForOrg(owner.id, 'code-review');
  }

  const user = await findUserById(owner.id);
  if (!user) throw new Error('Review Memory aggregation owner user not found');
  return user;
}

export async function generateReviewMemoryOpportunitiesWithGateway(
  input: ReviewMemoryAggregationGeneratorInput
): Promise<ReviewMemoryAggregationGeneratorResult> {
  const actor = await resolveAggregationActor(input.owner);
  const headers: Record<string, string> = {
    'User-Agent': 'Kilo Review Memory Aggregator',
    [FEATURE_HEADER]: 'code-review-memory',
  };
  if (input.owner.type === 'org') {
    headers['X-KiloCode-OrganizationId'] = input.owner.id;
  }

  const provider = createOpenAICompatible({
    name: 'kilo-gateway',
    baseURL: `${APP_URL}/api/openrouter`,
    apiKey: generateApiToken(actor, { internalApiUse: true }),
    headers,
  });
  const result = await generateText({
    model: provider.chatModel(input.modelSlug),
    prompt: input.prompt,
    maxOutputTokens: 4_000,
  });
  const parsed = AggregationOutputSchema.parse(extractJsonObject(result.text));

  return {
    opportunities: parsed.opportunities,
    tokensIn: result.usage.inputTokens ?? null,
    tokensOut: result.usage.outputTokens ?? null,
  };
}

async function resolveAggregationModel(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
}): Promise<{ modelSlug: string; config: CodeReviewAgentConfig | null }> {
  const ownerForConfig =
    input.owner.type === 'org'
      ? { type: 'org' as const, id: input.owner.id, userId: input.owner.id }
      : { type: 'user' as const, id: input.owner.id, userId: input.owner.id };
  const agentConfig = await getAgentConfigForOwner(ownerForConfig, 'code_review', input.platform);
  const parsed = CodeReviewAgentConfigSchema.safeParse(agentConfig?.config);
  if (!parsed.success) {
    return { modelSlug: DEFAULT_CODE_REVIEW_MODEL, config: null };
  }

  return { modelSlug: parsed.data.model_slug || DEFAULT_CODE_REVIEW_MODEL, config: parsed.data };
}

function proposalRollups(
  opportunity: ReviewMemoryAggregationOpportunity,
  eventById: Map<string, FeedbackEventForAggregation>
) {
  const evidenceIds = opportunity.evidenceEventIds.filter(id => eventById.has(id));
  const contradictoryIds = opportunity.contradictoryEventIds.filter(id => eventById.has(id));
  const allIds = [...new Set([...evidenceIds, ...contradictoryIds])];
  const events = allIds.map(id => eventById.get(id)).filter(event => event != null);
  const distinctPrs = new Set(
    events.flatMap(event => (event.pr_number == null ? [] : [event.pr_number]))
  );
  const distinctSubjects = new Set(
    events.flatMap(event => (event.subject_id == null ? [] : [event.subject_id]))
  );

  return {
    evidenceIds,
    contradictoryIds,
    positiveCount: events.filter(event => event.sentiment === 'positive').length,
    negativeCount: events.filter(event => event.sentiment === 'negative').length,
    neutralCount: events.filter(event => event.sentiment === 'neutral').length,
    distinctPrCount: distinctPrs.size,
    distinctSubjectCount: distinctSubjects.size,
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
      lastErrorMessage: null,
    });
    return { status: 'skipped', proposals: 0, reason: 'review-memory-disabled' };
  }

  const { modelSlug } = await resolveAggregationModel({ owner, platform: state.platform });
  const events = await listFeedbackEventsForAggregation({
    owner,
    platform: state.platform,
    repoFullName: state.repo_full_name,
    limit: REVIEW_MEMORY_AGGREGATION_THRESHOLDS.maxEventsPerScope,
  });
  const clusters = buildFeedbackClusters(events);
  const run = await createAggregationRun({
    owner,
    platform: state.platform,
    repoFullName: state.repo_full_name,
    platformProjectId: state.platform_project_id,
    modelSlug,
    trigger: 'manual',
    inputEventCount: events.length,
    inputSubjectCount: new Set(
      events.flatMap(event => (event.subject_id ? [event.subject_id] : []))
    ).size,
    inputClusterCount: clusters.length,
    freshEventCutoffAt: events[0]?.created_at ?? null,
  });

  try {
    if (events.length === 0 || !hasActionableCommentEvidence(events) || clusters.length === 0) {
      await markFeedbackEventsAggregationState({
        eventIds: events.map(event => event.id),
        aggregationState: 'ignored',
      });
      await updateAggregationRunStatus({
        runId: run.id,
        status: 'skipped',
        skipReason: 'no_actionable_comment_evidence',
      });
      await finishClaimedAggregationState({
        stateId: state.id,
        claimToken: state.claim_token,
        status: 'idle',
        nextEligibleAt: addMs(options.now, REVIEW_MEMORY_AGGREGATION_THRESHOLDS.cooldownMs),
        lastSuccessfulRunAt: options.now.toISOString(),
        lastModelSlug: modelSlug,
        lastErrorMessage: null,
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
        aggregationRunId: run.id,
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
        llmConfidence: confidenceToScore(opportunity.confidence),
        positiveCount: rollups.positiveCount,
        negativeCount: rollups.negativeCount,
        neutralCount: rollups.neutralCount,
        distinctPrCount: rollups.distinctPrCount,
        distinctSubjectCount: rollups.distinctSubjectCount,
        contradictoryCount: rollups.contradictoryIds.length,
        evidence: [
          ...rollups.evidenceIds.map(feedbackEventId => ({
            feedbackEventId,
            role: 'primary' as const,
          })),
          ...rollups.contradictoryIds.map(feedbackEventId => ({
            feedbackEventId,
            role: 'contradictory' as const,
          })),
        ],
      });
      proposalCount += 1;
    }

    await markFeedbackEventsIncluded({ eventIds: processedEventIds });
    await updateAggregationRunStatus({
      runId: run.id,
      status: 'completed',
      tokensIn: generation.tokensIn,
      tokensOut: generation.tokensOut,
    });
    await finishClaimedAggregationState({
      stateId: state.id,
      claimToken: state.claim_token,
      status: 'idle',
      nextEligibleAt: addMs(options.now, REVIEW_MEMORY_AGGREGATION_THRESHOLDS.cooldownMs),
      lastSuccessfulRunAt: options.now.toISOString(),
      lastModelSlug: modelSlug,
      lastErrorMessage: null,
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
    await updateAggregationRunStatus({
      runId: run.id,
      status: 'failed',
      errorMessage: message,
    });
    await finishClaimedAggregationState({
      stateId: state.id,
      claimToken: state.claim_token,
      status: 'failed',
      nextEligibleAt: addMs(options.now, REVIEW_MEMORY_AGGREGATION_THRESHOLDS.failureRetryMs),
      lastErrorMessage: message,
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
