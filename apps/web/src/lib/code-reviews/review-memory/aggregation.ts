import { generateText } from 'ai';
import * as z from 'zod';

import type { CodeReviewFeedbackEvent } from '@kilocode/db/schema';
import type { ReviewMemoryPlatform } from '@kilocode/db/schema-types';
import type { ReviewMemoryOwner } from './db';
import { listRecentFeedbackEvents, upsertScopeProposal } from './db';
import {
  createReviewMemoryGatewayProvider,
  extractReviewMemoryJsonObject,
  resolveReviewMemoryActor,
  resolveReviewMemoryModel,
} from './llm';
import { reviewMemoryRetentionCutoff } from './retention';

const REVIEW_MEMORY_FORBIDDEN_PROPOSAL_PATTERN =
  /\b(?:review\s+memory|kilo|feedback\s+systems?|this\s+analysis|llms?)\b/i;

const ReviewMemoryProposalDraftSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('no_change') }),
  z.object({
    status: z.literal('propose'),
    title: z.string().min(1).max(140),
    rationale: z.string().min(1).max(1_500),
    proposedMarkdown: z.string().min(1).max(4_000),
    positiveCount: z.number().int().min(0),
    negativeCount: z.number().int().min(0),
    neutralCount: z.number().int().min(0),
    evidenceEventIds: z.array(z.string()).max(20).default([]),
  }),
]);

export type ReviewMemoryProposalDraft = z.infer<typeof ReviewMemoryProposalDraftSchema>;

export type GenerateReviewMemoryProposal = (input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  events: CodeReviewFeedbackEvent[];
}) => Promise<{
  draft: ReviewMemoryProposalDraft;
  tokensIn?: number | null;
  tokensOut?: number | null;
}>;

export async function generateReviewMemoryProposalWithGateway(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  events: CodeReviewFeedbackEvent[];
}): Promise<{
  draft: ReviewMemoryProposalDraft;
  tokensIn?: number | null;
  tokensOut?: number | null;
}> {
  const actor = await resolveReviewMemoryActor(input.owner);
  const { modelSlug } = await resolveReviewMemoryModel({
    owner: input.owner,
    platform: input.platform,
  });
  const provider = createReviewMemoryGatewayProvider({
    owner: input.owner,
    actor,
    userAgent: 'Kilo Review Memory Analyzer',
  });
  const result = await generateText({
    model: provider.chatModel(modelSlug),
    prompt: buildReviewMemoryAnalysisPrompt(input),
    maxOutputTokens: 4_000,
  });

  return {
    draft: validateReviewMemoryProposalDraft(
      ReviewMemoryProposalDraftSchema.parse(extractReviewMemoryJsonObject(result.text))
    ),
    tokensIn: result.usage.inputTokens ?? null,
    tokensOut: result.usage.outputTokens ?? null,
  };
}

export async function runReviewMemoryAnalysis(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  generate?: GenerateReviewMemoryProposal;
  now?: Date;
}): Promise<{ status: 'proposed' | 'no_change' | 'no_feedback'; proposalId?: string }> {
  const events = await listRecentFeedbackEvents({
    owner: input.owner,
    platform: input.platform,
    repoFullName: input.repoFullName,
    since: reviewMemoryRetentionCutoff(input.now),
    limit: 200,
  });

  if (events.length === 0) return { status: 'no_feedback' };

  const generate = input.generate ?? generateReviewMemoryProposalWithGateway;
  const { draft } = await generate({
    owner: input.owner,
    platform: input.platform,
    repoFullName: input.repoFullName,
    events,
  });

  if (draft.status === 'no_change') return { status: 'no_change' };

  const eventsById = new Map(events.map(event => [event.id, event]));
  const citedEvents = draft.evidenceEventIds
    .map(eventId => eventsById.get(eventId))
    .filter(event => event !== undefined);
  const evidenceEvents = citedEvents.length > 0 ? citedEvents : events;
  const proposal = await upsertScopeProposal({
    owner: input.owner,
    platform: input.platform,
    repoFullName: input.repoFullName,
    title: draft.title,
    rationale: draft.rationale,
    proposedMarkdown: draft.proposedMarkdown,
    evidence: evidenceEvents.map(event => ({
      excerpt: event.reply_excerpt,
      prNumber: event.pr_number,
    })),
    positiveCount: draft.positiveCount,
    negativeCount: draft.negativeCount,
    neutralCount: draft.neutralCount,
  });

  return { status: 'proposed', proposalId: proposal.id };
}

function buildReviewMemoryAnalysisPrompt(input: {
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  events: CodeReviewFeedbackEvent[];
}): string {
  const events = input.events.map(event => ({
    id: event.id,
    prNumber: event.pr_number,
    kiloComment: event.kilo_comment_excerpt,
    reply: event.reply_excerpt,
  }));

  return `You analyze maintainer replies to Kilo's automated code-review comments for one repository.

Return strict JSON in one of these shapes:
{"status":"no_change"}
{"status":"propose","title":"short proposal title","rationale":"why this guidance is justified","proposedMarkdown":"standalone REVIEW.md guidance","positiveCount":0,"negativeCount":0,"neutralCount":0,"evidenceEventIds":["event ids"]}

Rules:
- Classify each maintainer reply as positive, negative, or neutral.
- Propose the smallest possible REVIEW.md change only when there is a clear, repeated pattern.
- Make your proposed markdown precise and evidence-backed: prefer one sentence or bullet that names the specific file pattern, API, workflow, or review rule from the feedback; avoid broad rewrites or generic best practices.
- Return status "no_change" when the signal is weak, one-off, contradictory, or already too repo-specific to generalize.
- Do not mention Review Memory, Kilo, feedback systems, this analysis, or LLMs in proposedMarkdown.
- Do not create a catch-all section. Write standalone repository guidance that a maintainer could edit.
- Use only the provided event ids in evidenceEventIds.
- Keep proposedMarkdown focused and under 4,000 characters.

Platform: ${input.platform}
Repository: ${input.repoFullName}

Feedback events:
${JSON.stringify(events, null, 2)}`;
}

function validateReviewMemoryProposalDraft(
  draft: ReviewMemoryProposalDraft
): ReviewMemoryProposalDraft {
  if (draft.status === 'no_change') return draft;
  if (REVIEW_MEMORY_FORBIDDEN_PROPOSAL_PATTERN.test(draft.proposedMarkdown)) {
    throw new Error(
      'Review Memory proposal must not mention Kilo, Review Memory, feedback systems, or LLMs.'
    );
  }
  return draft;
}
