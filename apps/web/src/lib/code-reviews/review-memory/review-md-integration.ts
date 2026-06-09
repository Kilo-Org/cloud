import { generateText } from 'ai';
import * as z from 'zod';

import type { CodeReviewMemoryProposal } from '@kilocode/db/schema';
import type { ReviewMemoryPlatform } from '@kilocode/db/schema-types';
import type { ReviewMemoryOwner } from './db';
import {
  createReviewMemoryGatewayProvider,
  extractReviewMemoryJsonObject,
  resolveReviewMemoryActor,
  resolveReviewMemoryModel,
} from './llm';

const MAX_REVIEW_MD_CHARS = 30_000;
const REVIEW_MEMORY_BRANDING_PATTERN = /\b(?:kilo\s+)?review\s+memory\b/i;
const REVIEW_MEMORY_HEADING_PATTERN = /^#{1,6}\s+(?:kilo\s+)?review\s+memory\b/im;

const ReviewMdIntegrationOutputSchema = z.object({
  status: z.enum(['updated', 'already_present']),
  updatedReviewMd: z.string().min(1).max(MAX_REVIEW_MD_CHARS).nullable(),
  integrationSummary: z.string().min(1).max(1_000),
});

export type ReviewMdIntegrationResult = {
  status: 'updated' | 'already_present';
  updatedReviewMd: string | null;
  integrationSummary: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
};

export async function generateIntegratedReviewGuidanceWithGateway(input: {
  owner: ReviewMemoryOwner;
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  existingReviewMd: string | null;
  proposal: CodeReviewMemoryProposal;
}): Promise<ReviewMdIntegrationResult> {
  if (input.existingReviewMd && input.existingReviewMd.length > MAX_REVIEW_MD_CHARS) {
    throw new Error(
      `Existing REVIEW.md is too large to safely integrate automatically (${input.existingReviewMd.length} characters).`
    );
  }

  const actor = await resolveReviewMemoryActor(input.owner);
  const { modelSlug } = await resolveReviewMemoryModel({
    owner: input.owner,
    platform: input.platform,
  });
  const provider = createReviewMemoryGatewayProvider({
    owner: input.owner,
    actor,
    userAgent: 'Kilo Review Memory Integrator',
  });

  const result = await generateText({
    model: provider.chatModel(modelSlug),
    prompt: buildReviewMdIntegrationPrompt(input),
    maxOutputTokens: 8_000,
  });
  const parsed = ReviewMdIntegrationOutputSchema.parse(extractReviewMemoryJsonObject(result.text));
  const validated = validateReviewMdIntegrationOutput(parsed);

  return {
    ...validated,
    tokensIn: result.usage.inputTokens ?? null,
    tokensOut: result.usage.outputTokens ?? null,
  };
}

function validateReviewMdIntegrationOutput(
  output: z.infer<typeof ReviewMdIntegrationOutputSchema>
): ReviewMdIntegrationResult {
  if (output.status === 'already_present') {
    return output;
  }

  if (!output.updatedReviewMd) {
    throw new Error('Integration model returned updated status without updatedReviewMd.');
  }

  if (!output.updatedReviewMd.trim()) {
    throw new Error('Integration model returned empty REVIEW.md content.');
  }

  if (
    REVIEW_MEMORY_HEADING_PATTERN.test(output.updatedReviewMd) ||
    REVIEW_MEMORY_BRANDING_PATTERN.test(output.updatedReviewMd)
  ) {
    throw new Error('Integrated REVIEW.md must not mention Review Memory.');
  }

  return output;
}

function buildReviewMdIntegrationPrompt(input: {
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  existingReviewMd: string | null;
  proposal: CodeReviewMemoryProposal;
}): string {
  const proposal = input.proposal;

  return `You are a repository maintainer editing REVIEW.md, the repository-maintained instructions for automated code review.

Return strict JSON with this shape:
{"status":"updated|already_present","updatedReviewMd":"complete updated REVIEW.md or null","integrationSummary":"short summary"}

Rules:
- Preserve existing guidance, ordering, and voice as much as possible.
- Integrate the proposal into the most relevant existing section when one exists.
- Add a new normal guidance section only when no existing section fits.
- Do not add a catch-all Review Memory section.
- Do not mention Review Memory, Kilo Review Memory, feedback aggregation, proposal systems, or LLMs in updatedReviewMd.
- Return status "already_present" when the existing REVIEW.md already contains equivalent guidance.
- Return status "updated" with the complete updated REVIEW.md when changes are needed.
- Do not truncate existing REVIEW.md content.

Platform: ${input.platform}
Repository: ${input.repoFullName}

Existing REVIEW.md:
${input.existingReviewMd ?? '(no REVIEW.md exists)'}

Approved proposal:
Title: ${proposal.title}
Rationale: ${proposal.rationale}
Proposed markdown:
${proposal.proposed_markdown}`;
}
