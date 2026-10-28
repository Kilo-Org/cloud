import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic.constants';
import { isGrokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/xai';
import type { AwsBedrockEndpoint } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/bedrock-byok';
import {
  isUsableModelsDevModel,
  toRawModel,
  type ModelsDevModel,
  type ModelsDevProvider,
  type RawModel,
} from './models-dev';

const BEDROCK_INFERENCE_PROFILE_PREFIX = /^(global|us|us-gov|eu|apac|au|jp|in|ca)\./;
const BEDROCK_MANTLE_SDK = '@ai-sdk/amazon-bedrock/mantle';
// Verified on 2026-10-26: Nova and Pixtral have no OpenAI-compatible or
// Anthropic endpoint (only Bedrock's native Converse API, which the gateway
// cannot proxy), and Qwen3 235B times out on mantle when given tools.
const BEDROCK_UNSUPPORTED_MODEL_PREFIXES = ['amazon.', 'mistral.pixtral-', 'qwen.qwen3-235b-'];
// Verified on 2026-10-26: open-weight models that mantle does not serve.
const BEDROCK_RUNTIME_ONLY_MODEL_PREFIXES = ['qwen.qwen3-next-', 'qwen.qwen3-vl-'];

/** Mantle drops runtime's version suffix: `qwen.qwen3-32b-v1:0` is `qwen.qwen3-32b`. */
function toBedrockMantleModelId(id: string) {
  return id.replace(/-v\d+:\d+$/, '').replace(/-\d+:\d+$/, '');
}

function selectBedrockModel(
  baseId: string,
  model: ModelsDevModel,
  globalModel: ModelsDevModel | null
): { model: ModelsDevModel; id: string; endpoint: AwsBedrockEndpoint } {
  // Claude on demand needs a cross-region inference profile.
  if (isClaudeModel(baseId)) {
    const selected = globalModel ?? model;
    return { model: selected, id: selected.id, endpoint: 'runtime-anthropic' };
  }
  // Grok returns its encrypted reasoning through the Responses API. Mantle
  // serves Grok 4.3; newer Grok models only have a runtime inference profile.
  if (isGrokModel(baseId)) {
    return globalModel
      ? { model: globalModel, id: globalModel.id, endpoint: 'runtime-responses' }
      : { model, id: model.id, endpoint: 'mantle-openai' };
  }
  // OpenAI's GPT models and Gemma only work through mantle's Responses API.
  if (model.provider?.npm === BEDROCK_MANTLE_SDK && model.provider.api?.endsWith('/openai/v1')) {
    return { model, id: model.id, endpoint: 'mantle-openai' };
  }
  if (globalModel) {
    return { model: globalModel, id: globalModel.id, endpoint: 'runtime-openai' };
  }
  if (BEDROCK_RUNTIME_ONLY_MODEL_PREFIXES.some(prefix => baseId.startsWith(prefix))) {
    return { model, id: model.id, endpoint: 'runtime-openai' };
  }
  // Mantle returns open-weight models' reasoning as a separate `reasoning`
  // string, where runtime inlines it into the content.
  return { model, id: toBedrockMantleModelId(model.id), endpoint: 'mantle-chat' };
}

/**
 * One entry per Bedrock model, on the endpoint that serves it best; see
 * `selectBedrockModel`. Models that models.dev lists only as `global.`
 * inference profiles are included through that profile.
 */
export function parseAwsBedrockModelsDevModels({ models }: ModelsDevProvider): RawModel[] {
  const usable = Object.values(models).filter(isUsableModelsDevModel);
  const usableIds = new Set(usable.map(model => model.id));
  const baseIds = new Set(
    usable.map(model => model.id.replace(BEDROCK_INFERENCE_PROFILE_PREFIX, ''))
  );

  const selected = new Map<string, RawModel>();
  for (const baseId of baseIds) {
    if (BEDROCK_UNSUPPORTED_MODEL_PREFIXES.some(prefix => baseId.startsWith(prefix))) continue;
    const globalModel = usableIds.has(`global.${baseId}`) ? models[`global.${baseId}`] : null;
    const baseModel = usableIds.has(baseId) ? models[baseId] : globalModel;
    if (!baseModel) continue;
    const { model, id, endpoint } = selectBedrockModel(baseId, baseModel, globalModel);
    if (!selected.has(id)) {
      selected.set(id, { ...toRawModel(model), id, endpoint });
    }
  }
  return [...selected.values()];
}
