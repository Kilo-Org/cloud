import * as z from 'zod';
import { CODE_REVIEW_TYPES, COUNCIL_AGGREGATION_STRATEGIES } from '@kilocode/db/schema-types';

/**
 * Cross-service wire contract for code-reviewer -> cloud-agent review agent selections.
 *
 * FORWARD-SHAPED for the upcoming council (multi-agent) mode: today only a single
 * `role: 'standard'` agent is produced/consumed. A council review will populate one
 * entry per specialist, each with its own requested model.
 *
 * This is the single source of truth for the shape. Both the producer
 * (`apps/web` prepare-review-payload) and the consumer (`services/code-review-infra`)
 * import the inferred types from here so council-mode additions cannot drift.
 */

/** One reviewing agent's selection. */
export const ReviewAgentSelectionSchema = z.object({
  /** `'standard'` for the standard reviewer; a specialist role/id for council members. */
  role: z.string(),
  /** Requested model slug; falls back to the review default when null. */
  model: z.string().nullable(),
  /** Requested thinking-effort variant; null = model default. */
  thinkingEffort: z.string().nullable(),
});

/**
 * Review agent configuration carried along the code-reviewer -> cloud-agent path.
 *
 * NOTE (forward plumbing): only `agents[0]` (the standard agent) is consumed today;
 * `reviewType`, `aggregationStrategy`, and additional `agents[]` entries are carried
 * end-to-end for council mode but are not yet consumed by execution.
 */
export const ReviewAgentsConfigSchema = z.object({
  // Reuse the persisted-config enums (single source of truth in @kilocode/db/schema-types)
  // so the wire contract and the stored council config can't drift.
  reviewType: z.enum(CODE_REVIEW_TYPES),
  /** Council-only: how specialist votes combine. Unused for standard. */
  aggregationStrategy: z.enum(COUNCIL_AGGREGATION_STRATEGIES).optional(),
  agents: z.array(ReviewAgentSelectionSchema),
});

export type ReviewAgentSelection = z.infer<typeof ReviewAgentSelectionSchema>;
export type ReviewAgentsConfig = z.infer<typeof ReviewAgentsConfigSchema>;
