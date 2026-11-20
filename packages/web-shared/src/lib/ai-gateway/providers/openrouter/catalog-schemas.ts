/**
 * HTTP response shapes for the OpenRouter `/api/v1/models` and `/providers` endpoints.
 */
import * as z from 'zod';
import { EnkryptPublishedBenchmarkSchema, OpenCodeSettingsSchema } from '@kilocode/db/schema-types';

const OpenRouterProviderSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  slug: z.string(),
  baseUrl: z.string().optional(),
  dataPolicy: z
    .object({
      /** Stores prompts for feedback or training; governed by `data_collection`. */
      training: z.boolean().optional(),
      /** Stores prompts for any reason, including compliance; governed by `zdr`. */
      retainsPrompts: z.boolean().optional(),
      canPublish: z.boolean().optional(),
      termsOfServiceURL: z.string().optional(),
      privacyPolicyURL: z.string().optional(),
    })
    .optional(),
  headquarters: z.string().optional(),
  datacenters: z.array(z.string()).optional(),
  hasChatCompletions: z.boolean().optional(),
  hasCompletions: z.boolean().optional(),
  isAbortable: z.boolean().optional(),
  moderationRequired: z.boolean().optional(),
  editors: z.array(z.string()).optional(),
  owners: z.array(z.string()).optional(),
  adapterName: z.string().optional(),
  isMultipartSupported: z.boolean().optional(),
  statusPageUrl: z.string().nullable().optional(),
  byokEnabled: z.boolean().optional(),
  icon: z
    .object({
      url: z.string(),
      className: z.string().optional(),
    })
    .optional(),
  ignoredProviderModels: z.array(z.string()).optional(),
});

export const OpenRouterProvidersResponseSchema = z.object({
  data: z.array(OpenRouterProviderSchema),
});

const OpenRouterModelSchema = z.object({
  // kilocode additions:
  preferredIndex: z.number().optional(),
  isFree: z.boolean().optional(),
  mayTrainOnYourPrompts: z.boolean().optional(),
  hasUserByokAvailable: z.boolean().optional(),
  /** A custom LLM (`custom_llm2`) configured by a Kilo admin. */
  isCustomLlm: z.boolean().optional(),
  autoRouting: z
    .object({
      models: z.array(z.string()),
    })
    .optional(),
  terminalBench: z
    .object({
      overallScore: z.number(),
      avgAttemptCostUsd: z.number(),
    })
    .optional(),
  enkrypt: EnkryptPublishedBenchmarkSchema.optional(),
  opencode: OpenCodeSettingsSchema.optional(),
  alias_target: z.string().optional().catch(undefined),
  inference_provider_ids: z.array(z.string()).optional(),
  /**
   * The date this entry retires, as the note date (`yyyy-MM-dd`), set only while the note applies.
   * The note words it in the reader's own language, so the name carries no English copy.
   */
  retires_on: z.string().optional(),

  id: z.string(),
  name: z.string(),
  created: z.number(),
  description: z.string(),
  architecture: z.object({
    modality: z.string().nullable().optional(),
    input_modalities: z.array(z.string()),
    output_modalities: z.array(z.string()),
    tokenizer: z.string(),
  }),
  top_provider: z.object({
    is_moderated: z.boolean(),
    context_length: z.number().nullable().optional(),
    max_completion_tokens: z.number().nullable().optional(),
  }),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
    image: z.string().optional(),
    request: z.string().optional(),
    input_cache_read: z.string().optional(),
    input_cache_write: z.string().optional(),
    web_search: z.string().optional(),
    internal_reasoning: z.string().optional(),
    discount: z.number().optional(),
  }),
  context_length: z.number(),
  per_request_limits: z.record(z.string(), z.unknown()).nullable().optional(),
  supported_parameters: z.array(z.string()).optional(),
  expiration_date: z.string().nullable().optional(), // format: yyyy-MM-dd
});

export const OpenRouterModelsResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema),
});

export type OpenRouterProvider = z.infer<typeof OpenRouterProviderSchema>;
export type OpenRouterProvidersResponse = z.infer<typeof OpenRouterProvidersResponseSchema>;
export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;
export type OpenRouterModelsResponse = z.infer<typeof OpenRouterModelsResponseSchema>;
