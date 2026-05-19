import * as z from 'zod';
import {
  CustomLlmExtraBodySchema,
  OpenCodeSettingsSchema,
  OpenClawModelSettingsSchema,
} from '@kilocode/db/schema-types';

/**
 * Strict subset of `CustomLlmDefinitionSchema` for experiment variant versions.
 *
 * - **Does not include `api_key`.** The encrypted key lives in the sibling
 *   `model_experiment_variant_version.encrypted_api_key` JSONB column so the
 *   never-read invariant is enforceable at the column level. See
 *   `.plans/experimental-models-1.md` §"API Keys".
 * - **Does not include `extra_headers`.** Partner checkpoint routing should
 *   use `api_key` + `base_url` + `internal_id` + adapter settings. If a
 *   non-secret header is required later, add an explicit allowlisted field
 *   for that concrete requirement.
 * - **Does not include `organization_ids`, `pricing`, `display_name`,
 *   `context_length`, or `max_completion_tokens`.** These belong on the
 *   public id (registered in `kiloExclusiveModels`) and are identical
 *   across variants.
 */
export const ExperimentUpstreamSchema = z
  .object({
    internal_id: z.string().min(1),
    base_url: z.string().url(),
    opencode_settings: z
      .object({
        ai_sdk_provider: OpenCodeSettingsSchema.shape.ai_sdk_provider,
      })
      .strict()
      .optional(),
    openclaw_settings: z
      .object({
        api_adapter: OpenClawModelSettingsSchema.shape.api_adapter,
      })
      .strict()
      .optional(),
    extra_body: CustomLlmExtraBodySchema.optional(),
    remove_from_body: z.array(z.string()).optional(),
    add_cache_breakpoints: z.boolean().optional(),
    inject_reasoning_into_content: z.boolean().optional(),
  })
  .strict();

export type ExperimentUpstream = z.infer<typeof ExperimentUpstreamSchema>;
