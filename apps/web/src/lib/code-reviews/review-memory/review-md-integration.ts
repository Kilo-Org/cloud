import * as z from 'zod';

import type { CodeReviewMemoryProposal } from '@kilocode/db/schema';
import type { ReviewMemoryPlatform } from '@kilocode/db/schema-types';
import type { ReviewMemoryOwner } from './db';
import {
  createReviewMemoryGatewayProvider,
  generateReviewMemoryStructuredOutput,
  resolveReviewMemoryActor,
  resolveReviewMemoryModel,
} from './llm';

const MAX_REVIEW_MD_CHARS = 30_000;
export const MAX_INTEGRATION_SUMMARY_CHARS = 1_000;
const REVIEW_MEMORY_BRANDING_PATTERN = /\b(?:kilo\s+)?review\s+memory\b/i;
const REVIEW_MEMORY_HEADING_PATTERN = /^#{1,6}\s+(?:kilo\s+)?review\s+memory\b/im;

// Structural constraints only. transformReviewMemoryWireSchema (llm.ts) strips
// minLength/maxLength from the wire schema the model receives, so the model is never
// told about length limits. Enforcing .min()/.max() here would reject complete, usable
// responses with "No object generated: response did not match schema" (the plug-and-pay
// failure). Length limits are applied in validateReviewMdIntegrationOutput below.
export const ReviewMdIntegrationOutputSchema = z.object({
  status: z.enum(['updated', 'already_present']),
  updatedReviewMd: z.string().nullable(),
  integrationSummary: z.string(),
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

  const result = await generateReviewMemoryStructuredOutput({
    model: provider.chatModel(modelSlug),
    prompt: buildReviewMdIntegrationPrompt(input),
    maxOutputTokens: 8_000,
    schemaName: 'review_md_integration',
    schema: ReviewMdIntegrationOutputSchema,
    validate: validateReviewMdIntegrationOutput,
  });

  return {
    ...result.output,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  };
}

export function validateReviewMdIntegrationOutput(
  output: z.infer<typeof ReviewMdIntegrationOutputSchema>
): ReviewMdIntegrationResult {
  // integrationSummary is advisory and has no downstream consumer, so clamp it to the
  // limit rather than failing the whole change request over a summary that ran long.
  const integrationSummary =
    output.integrationSummary.trim().slice(0, MAX_INTEGRATION_SUMMARY_CHARS) ||
    'Updated REVIEW.md guidance.';

  if (output.status === 'already_present') {
    return { status: output.status, updatedReviewMd: output.updatedReviewMd, integrationSummary };
  }

  if (!output.updatedReviewMd || !output.updatedReviewMd.trim()) {
    throw new Error('Integration model returned updated status without updatedReviewMd.');
  }

  if (output.updatedReviewMd.length > MAX_REVIEW_MD_CHARS) {
    throw new Error(
      `Integrated REVIEW.md exceeds ${MAX_REVIEW_MD_CHARS} characters (${output.updatedReviewMd.length}).`
    );
  }

  if (
    REVIEW_MEMORY_HEADING_PATTERN.test(output.updatedReviewMd) ||
    REVIEW_MEMORY_BRANDING_PATTERN.test(output.updatedReviewMd)
  ) {
    throw new Error('Integrated REVIEW.md must not mention Review Memory.');
  }

  return { status: output.status, updatedReviewMd: output.updatedReviewMd, integrationSummary };
}

function buildReviewMdIntegrationPrompt(input: {
  platform: ReviewMemoryPlatform;
  repoFullName: string;
  existingReviewMd: string | null;
  proposal: CodeReviewMemoryProposal;
}): string {
  const proposal = input.proposal;

  return `You are a repository maintainer editing REVIEW.md, the repository-maintained instructions for automated code review.

Rules:
- Preserve existing guidance, ordering, and voice as much as possible.
- Integrate the proposal into the most relevant existing section when one exists.
- Make the smallest possible textual change to REVIEW.md; prefer adding or editing one sentence or bullet.
- Do not reorganize, rewrite, reformat, rename headings, or change unrelated guidance.
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
