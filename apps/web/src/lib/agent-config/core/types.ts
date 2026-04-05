import * as z from 'zod';
export {
  ManuallyAddedRepositorySchema,
  CodeReviewAgentConfigSchema,
} from '@kilocode/db/schema-types';
export type { ManuallyAddedRepository, CodeReviewAgentConfig } from '@kilocode/db/schema-types';

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
  commentFormatOverrides: z.record(z.string(), z.string()).optional(),
  summaryFormatOverrides: z
    .record(z.string(), z.object({ issuesFound: z.string(), noIssues: z.string() }))
    .optional(),
});

export type RemotePromptTemplate = z.infer<typeof RemotePromptTemplateSchema>;

/**
 * Zod schema for ReviewConfig validation
 * Ensures all config values are safe before workflow generation
 */
export const ReviewConfigSchema = z.object({
  reviewStyle: z.enum(['strict', 'balanced', 'lenient', 'roast'], {
    message: 'reviewStyle must be one of: strict, balanced, lenient, roast',
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
