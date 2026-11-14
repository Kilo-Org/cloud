import * as z from 'zod';

import type { CodeReviewFeedbackEvent } from '@kilocode/db/schema';
import type { ReviewMemoryPlatform } from '@kilocode/db/schema-types';
import type { ReviewMemoryOwner } from './db';
import { listRecentFeedbackEvents, upsertScopeProposal } from './db';
import {
  createReviewMemoryGatewayProvider,
  generateReviewMemoryStructuredOutput,
  resolveReviewMemoryActor,
  resolveReviewMemoryModel,
} from './llm';
import { reviewMemoryRetentionCutoff } from './retention';

const REVIEW_MEMORY_FORBIDDEN_PROPOSAL_PATTERN =
  /\b(?:review\s+memory|kilo|feedback\s+systems?|this\s+analysis|llms?)\b/i;

/**
 * Caps applied in `validateReviewMemoryProposalDraft`, never in the schema the model
 * must satisfy: `transformReviewMemoryWireSchema` strips minLength/maxLength/minimum,
 * so a bound in the schema rejects complete responses the model was never told about
 * (see the llm.ts header).
 */
export const REVIEW_MEMORY_PROPOSAL_LIMITS = {
  titleChars: 140,
  rationaleChars: 1_500,
  proposedMarkdownChars: 4_000,
  evidenceEventIds: 20,
} as const;

const ReviewMemoryProposalDraftSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('no_change') }),
  z.object({
    status: z.literal('propose'),
    title: z.string(),
    rationale: z.string(),
    proposedMarkdown: z.string(),
    positiveCount: z.number().int(),
    negativeCount: z.number().int(),
    neutralCount: z.number().int(),
    evidenceEventIds: z.array(z.string()),
  }),
]);

export const ReviewMemoryProposalOutputSchema = z.object({
  proposal: ReviewMemoryProposalDraftSchema,
});

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
  const result = await generateReviewMemoryStructuredOutput({
    model: provider.chatModel(modelSlug),
    prompt: buildReviewMemoryAnalysisPrompt(input),
    maxOutputTokens: 4_000,
    schemaName: 'review_memory_proposal',
    schema: ReviewMemoryProposalOutputSchema,
    validate: output => ({
      proposal: validateReviewMemoryProposalDraft(output.proposal),
    }),
  });

  return {
    draft: result.output.proposal,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
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

Rules:
- Classify each maintainer reply as positive, negative, or neutral.
- Set proposal.status to "propose" only when there is a clear, repeated pattern, and populate every proposal field.
- Set proposal.status to "no_change" when the signal is weak, one-off, contradictory, or already too repo-specific to generalize.
- Make proposal.proposedMarkdown precise and evidence-backed: prefer one sentence or bullet that names the specific file pattern, API, workflow, or review rule from the feedback; avoid broad rewrites or generic best practices.
- Use non-empty proposal title, rationale, and proposedMarkdown values and non-negative integer counts.
- Do not mention Review Memory, Kilo, feedback systems, this analysis, or LLMs in proposal.proposedMarkdown.
- Do not create a catch-all section. Write standalone repository guidance that a maintainer could edit.
- Use only the provided event ids in proposal.evidenceEventIds, with at most 20 ids.
- Keep proposal.proposedMarkdown focused and under 4,000 characters.

Platform: ${input.platform}
Repository: ${input.repoFullName}

Feedback events:
${JSON.stringify(events, null, 2)}`;
}

export function validateReviewMemoryProposalDraft(
  draft: ReviewMemoryProposalDraft
): ReviewMemoryProposalDraft {
  if (draft.status === 'no_change') return draft;
  if (REVIEW_MEMORY_FORBIDDEN_PROPOSAL_PATTERN.test(draft.proposedMarkdown)) {
    throw new Error(
      'Review Memory proposal must not mention Kilo, Review Memory, feedback systems, or LLMs.'
    );
  }
  assertProposalFieldWithinLimit('title', draft.title, REVIEW_MEMORY_PROPOSAL_LIMITS.titleChars);
  assertProposalFieldWithinLimit(
    'rationale',
    draft.rationale,
    REVIEW_MEMORY_PROPOSAL_LIMITS.rationaleChars
  );
  assertProposalFieldWithinLimit(
    'proposedMarkdown',
    draft.proposedMarkdown,
    REVIEW_MEMORY_PROPOSAL_LIMITS.proposedMarkdownChars
  );
  if (draft.evidenceEventIds.length > REVIEW_MEMORY_PROPOSAL_LIMITS.evidenceEventIds) {
    throw new Error(
      `Review Memory proposal cites ${draft.evidenceEventIds.length} evidence events; at most ${REVIEW_MEMORY_PROPOSAL_LIMITS.evidenceEventIds} are allowed.`
    );
  }
  for (const [field, count] of [
    ['positiveCount', draft.positiveCount],
    ['negativeCount', draft.negativeCount],
    ['neutralCount', draft.neutralCount],
  ] as const) {
    if (count < 0) {
      throw new Error(`Review Memory proposal ${field} must be non-negative (${count}).`);
    }
  }
  return draft;
}

function assertProposalFieldWithinLimit(field: string, value: string, maxChars: number): void {
  if (value.length === 0) {
    throw new Error(`Review Memory proposal ${field} must not be empty.`);
  }
  if (value.length > maxChars) {
    throw new Error(
      `Review Memory proposal ${field} exceeds ${maxChars} characters (${value.length}).`
    );
  }
}
