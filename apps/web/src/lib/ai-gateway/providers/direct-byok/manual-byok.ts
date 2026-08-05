import {
  ManualByokProviderDefinitionSchema,
  type ManualByokModel,
  type ManualByokProviderDefinition,
} from '@kilocode/db/schema-types';
import * as z from 'zod';
import { DEFAULT_BYOK_CONTEXT_LENGTH, DEFAULT_BYOK_MAX_COMPLETION_TOKENS } from './constants';

export const MANUAL_BYOK_PROVIDER_PREFIX = 'manual:';
export const ManualByokProviderCodeSchema = z
  .string()
  .trim()
  .regex(/^[a-z]+(?:-[a-z]+)*$/, 'Use lowercase letters and hyphens only.');
export const ManualByokProviderIdSchema = z
  .string()
  .regex(/^manual:[a-z]+(?:-[a-z]+)*$/) as z.ZodType<`manual:${string}`>;

export type ManualByokProviderId = z.infer<typeof ManualByokProviderIdSchema>;

export function formatManualByokProviderId(code: string): ManualByokProviderId {
  return ManualByokProviderIdSchema.parse(
    `${MANUAL_BYOK_PROVIDER_PREFIX}${ManualByokProviderCodeSchema.parse(code)}`
  );
}

export function isManualByokEnabled(): boolean {
  return !process.env.VERCEL && !process.env.VERCEL_ENV;
}

function apiForAiSdkProvider(provider: ManualByokProviderDefinition['preferred_ai_sdk_provider']) {
  if (provider === 'anthropic') return 'messages';
  if (provider === 'openai') return 'responses';
  return 'chat_completions';
}

export const ValidatedManualByokProviderDefinitionSchema =
  ManualByokProviderDefinitionSchema.superRefine((definition, ctx) => {
    const supportedApis = new Set(definition.supported_apis);
    if (supportedApis.size !== definition.supported_apis.length) {
      ctx.addIssue({ code: 'custom', path: ['supported_apis'], message: 'APIs must be unique.' });
    }
    const parsedUrl = new URL(definition.base_url);
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
      ctx.addIssue({
        code: 'custom',
        path: ['base_url'],
        message: 'Base URLs cannot contain credentials, query strings, or fragments.',
      });
    }
    const preferredApi = apiForAiSdkProvider(definition.preferred_ai_sdk_provider);
    if (!supportedApis.has(preferredApi)) {
      ctx.addIssue({
        code: 'custom',
        path: ['preferred_ai_sdk_provider'],
        message: `The preferred AI SDK provider requires the ${preferredApi} API.`,
      });
    }

    const modelIds = new Set<string>();
    for (const [index, model] of definition.models.entries()) {
      const normalizedId = model.id.toLowerCase();
      if (modelIds.has(normalizedId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', index, 'id'],
          message: 'Model IDs must be unique when compared case-insensitively.',
        });
      }
      modelIds.add(normalizedId);
      if (
        model.preferred_ai_sdk_provider &&
        !supportedApis.has(apiForAiSdkProvider(model.preferred_ai_sdk_provider))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', index, 'preferred_ai_sdk_provider'],
          message: 'The model AI SDK provider requires an API this provider does not support.',
        });
      }
    }
  });

export function parseManualByokProviderDefinition(value: unknown): ManualByokProviderDefinition {
  return ValidatedManualByokProviderDefinitionSchema.parse(value);
}

export function safeParseManualByokProviderDefinition(value: unknown) {
  return ValidatedManualByokProviderDefinitionSchema.safeParse(value);
}

export function formatManualByokModelId(providerId: ManualByokProviderId, modelId: string): string {
  return `${providerId}/${modelId}`.toLowerCase();
}

export function resolveManualByokModel(
  definition: ManualByokProviderDefinition,
  model: ManualByokModel
) {
  const contextLength =
    model.context_length ?? definition.model_defaults.context_length ?? DEFAULT_BYOK_CONTEXT_LENGTH;
  return {
    name: model.name ?? model.id,
    supportsImageInput:
      model.supports_image_input ?? definition.model_defaults.supports_image_input,
    supportsReasoning: model.supports_reasoning ?? definition.model_defaults.supports_reasoning,
    addCacheBreakpoints:
      model.add_cache_breakpoints ?? definition.model_defaults.add_cache_breakpoints,
    contextLength,
    maxCompletionTokens: Math.min(
      model.max_completion_tokens ??
        definition.model_defaults.max_completion_tokens ??
        DEFAULT_BYOK_MAX_COMPLETION_TOKENS,
      contextLength
    ),
    preferredAiSdkProvider: model.preferred_ai_sdk_provider ?? definition.preferred_ai_sdk_provider,
  };
}
