import * as z from 'zod';
export {
  ManuallyAddedRepositorySchema,
  CodeReviewAgentConfigSchema,
} from '@kilocode/db/schema-types';
export type { ManuallyAddedRepository, CodeReviewAgentConfig } from '@kilocode/db/schema-types';

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
  modelSlug: z
    .string()
    .regex(
      /^[a-zA-Z0-9._/-]+$/,
      'modelSlug must only contain alphanumeric characters, dots, hyphens, underscores, and forward slashes'
    ),
});

// Ensure the interface matches the Zod schema
export type ReviewConfigValidated = z.infer<typeof ReviewConfigSchema>;
