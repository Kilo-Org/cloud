import 'server-only';

import type { User } from '@kilocode/db';
import { z } from 'zod';
import { getEnhancedOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { getDirectByokModelsForUser } from '@/lib/ai-gateway/providers/direct-byok';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';
import { appendLocalFakeDeterministicCatalogModels } from '@/lib/ai-gateway/local-fake-llm';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';
import {
  IsolateReviewInferenceSchema,
  type IsolateReviewInference,
} from '@/lib/isolate-review-worker-client';

const InferenceSchema = IsolateReviewInferenceSchema.extend({
  maxOutputTokens: z.number().int().positive().max(32_000),
});
const ModelIdSchema = InferenceSchema.shape.modelId;
const ThinkingEffortSchema = InferenceSchema.shape.thinkingEffort;
const VariantSchema = InferenceSchema.shape.variant.unwrap();
const CatalogModelSchema = z.object({
  id: ModelIdSchema,
  context_length: z.number().int().positive(),
  max_completion_tokens: z.number().int().positive().nullish(),
  top_provider: z
    .object({ max_completion_tokens: z.number().int().positive().nullish() })
    .optional(),
  supported_parameters: z.array(z.string()).optional(),
  opencode: z
    .object({
      ai_sdk_provider: InferenceSchema.shape.provider.optional(),
      variants: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

export function validateIsolateReviewInference(value: unknown): IsolateReviewInference {
  const inference = InferenceSchema.parse(value);
  const { modelId, provider, thinkingEffort, variant, reasoningSupported } = inference;
  if ((thinkingEffort === null) !== (variant === null)) {
    throw new Error('A selected thinking variant must have resolved settings');
  }
  if (modelId.startsWith('kilo-auto/') && thinkingEffort !== null) {
    throw new Error('Auto models control their own thinking settings');
  }
  if (
    modelId.toLowerCase().startsWith('kilo-auto/') &&
    (inference.temperature !== undefined || inference.topP !== undefined)
  ) {
    throw new Error('Auto models control their own sampling settings');
  }
  const reasoning = variant?.reasoning;
  const verbosity = variant?.verbosity;
  if (
    (reasoning?.enabled === true && reasoning.effort === 'none') ||
    (reasoning?.enabled === false && reasoning.effort !== undefined && reasoning.effort !== 'none')
  ) {
    throw new Error('Contradictory thinking settings');
  }
  if (reasoning && !reasoningSupported) {
    throw new Error('The model does not advertise reasoning support');
  }
  if (provider === 'anthropic') {
    if (reasoning?.effort !== undefined && reasoning.enabled === undefined) {
      throw new Error('Anthropic reasoning requires an explicit enabled setting');
    }
    if (reasoning?.effort && reasoning.effort !== 'none' && reasoning.effort !== verbosity) {
      throw new Error('Anthropic effort must be represented by catalog verbosity');
    }
  }
  if (
    (provider === 'openai' || provider === 'openai-compatible') &&
    reasoning?.enabled !== undefined &&
    reasoning.effort === undefined
  ) {
    throw new Error('This protocol requires a catalog reasoning effort');
  }
  if (provider === 'openai' && (verbosity === 'xhigh' || verbosity === 'max')) {
    throw new Error('Responses does not support this text verbosity');
  }
  return inference;
}

export function resolveIsolateReviewInferenceFromCatalog(
  value: unknown,
  thinkingEffort: string | null = null
): IsolateReviewInference {
  const model = CatalogModelSchema.parse(value);
  const effort = ThinkingEffortSchema.parse(thinkingEffort);
  if (model.id.startsWith('kilo-auto/') && effort !== null) {
    throw new Error('Auto models control their own thinking settings');
  }
  if (model.supported_parameters && !model.supported_parameters.includes('tools')) {
    throw new Error('The model does not support review tools');
  }
  const variants = model.opencode?.variants;
  if (effort !== null && (!variants || !Object.hasOwn(variants, effort))) {
    throw new Error('Unknown thinking variant for this model');
  }
  const normalizedModelId = model.id.toLowerCase();
  const isQwen = !normalizedModelId.startsWith('kilo-auto/') && normalizedModelId.includes('qwen');
  return validateIsolateReviewInference({
    modelId: model.id,
    provider: model.opencode?.ai_sdk_provider ?? 'openrouter',
    thinkingEffort: effort,
    variant: effort === null ? null : VariantSchema.parse(variants?.[effort]),
    reasoningSupported: model.supported_parameters?.includes('reasoning') ?? false,
    ...(isQwen &&
    !normalizedModelId.includes('north-mini-code') &&
    model.supported_parameters?.includes('temperature')
      ? { temperature: 0.55 }
      : {}),
    ...(isQwen && model.supported_parameters?.includes('top_p') ? { topP: 1 } : {}),
    maxOutputTokens: Math.min(
      model.top_provider?.max_completion_tokens ??
        model.max_completion_tokens ??
        Math.ceil(model.context_length * 0.2),
      32_000
    ),
  });
}

export async function resolveIsolateReviewInference(options: {
  user: User;
  organizationId?: string;
  model: string;
  thinkingEffort?: string | null;
}): Promise<IsolateReviewInference> {
  const modelId = ModelIdSchema.parse(options.model);
  const effort = ThinkingEffortSchema.parse(options.thinkingEffort ?? null);
  if (modelId.startsWith('kilo-auto/') && effort !== null) {
    throw new Error('Auto models control their own thinking settings');
  }
  const organizationId = z.string().min(1).max(256).optional().parse(options.organizationId);
  const models = organizationId
    ? (
        await getAvailableModelsForOrganization(organizationId, {
          type: 'member',
          kiloUserId: options.user.id,
        })
      )?.data
    : await Promise.all([
        getEnhancedOpenRouterModels(),
        getDirectByokModelsForUser(options.user.id),
        listAvailableExperimentModels(),
      ]).then(([catalog, byok, experiments]) =>
        appendLocalFakeDeterministicCatalogModels([...catalog.data, ...byok, ...experiments])
      );
  const model = models?.find(entry => entry.id === modelId);
  if (!model) throw new Error('The model is not available to the review owner');
  return resolveIsolateReviewInferenceFromCatalog(model, effort);
}
