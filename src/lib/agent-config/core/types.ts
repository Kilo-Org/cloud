import * as z from 'zod';

/**
 * Schema for manually added repository (for GitLab where pagination limits results)
 */
export const ManuallyAddedRepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
});

export type ManuallyAddedRepository = z.infer<typeof ManuallyAddedRepositorySchema>;

/**
 * Zod schema for CodeReviewAgentConfig
 */
export const CodeReviewAgentConfigSchema = z.object({
  review_style: z.enum(['strict', 'balanced', 'lenient']),
  focus_areas: z.array(z.string()),
  auto_approve_minor: z.boolean().optional(),
  custom_instructions: z.string().nullable().optional(),
  max_review_time_minutes: z.number().int().positive(),
  model_slug: z.string(),
  repository_selection_mode: z.enum(['all', 'selected']).optional(),
  selected_repository_ids: z.array(z.number()).optional(),
  // Manually added repositories (for GitLab where pagination limits results)
  manually_added_repositories: z.array(ManuallyAddedRepositorySchema).optional(),
});

export type CodeReviewAgentConfig = z.infer<typeof CodeReviewAgentConfigSchema>;

/**
 * Zod schema for remote prompt template from PostHog
 * Used to fetch and validate prompt configurations remotely
 */
export const RemotePromptTemplateSchema = z.object({
  version: z.string(), // e.g., "v1.0.0"
  securityBoundaries: z.string().optional(),
  reviewInstructions: z.string().optional(),
  styleGuidance: z.record(z.string(), z.string()).optional(),
  focusAreaDetails: z.record(z.string(), z.string()).optional(),
});

export type RemotePromptTemplate = z.infer<typeof RemotePromptTemplateSchema>;

/**
 * Zod schema for ReviewConfig validation
 * Ensures all config values are safe before workflow generation
 */
export const ReviewConfigSchema = z.object({
  reviewStyle: z.enum(['strict', 'balanced', 'lenient'], {
    message: 'reviewStyle must be one of: strict, balanced, lenient',
  }),
  focusAreas: z.array(
    z.enum(['security', 'performance', 'bugs', 'style', 'testing', 'documentation'], {
      message:
        'focusAreas must only contain: security, performance, bugs, style, testing, documentation',
    })
  ),
  customInstructions: z.string().nullable(),
  maxReviewTimeMinutes: z
    .number()
    .int()
    .min(1, 'maxReviewTimeMinutes must be at least 1')
    .max(120, 'maxReviewTimeMinutes must be at most 120'),
  modelSlug: z
    .string()
    .regex(
      /^[a-zA-Z0-9._/-]+$/,
      'modelSlug must only contain alphanumeric characters, dots, hyphens, underscores, and forward slashes'
    ),
});

// Ensure the interface matches the Zod schema
export type ReviewConfigValidated = z.infer<typeof ReviewConfigSchema>;
