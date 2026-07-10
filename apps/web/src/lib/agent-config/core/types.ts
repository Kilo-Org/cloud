import * as z from 'zod';
import { REVIEW_FOCUS_AREAS, REVIEW_STYLES } from '@kilocode/app-shared/code-review';
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
  reviewStyle: z.enum(REVIEW_STYLES, {
    message: 'reviewStyle must be one of: strict, balanced, lenient, roast',
  }),
  focusAreas: z.array(
    z.enum(REVIEW_FOCUS_AREAS, {
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
