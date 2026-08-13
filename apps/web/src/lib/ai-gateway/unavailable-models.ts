import { normalizeModelId } from '@/lib/ai-gateway/model-utils';

const unavailableModelIds: ReadonlySet<string> = new Set([
  'google/gemma-4-26b-a4b-it:free', // usable through kilo-auto
  'google/gemma-4-31b-it:free',
  'meituan/longcat-2.0-free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'openai/gpt-oss-20b:free',
]);

export function isUnavailableModel(modelId: string): boolean {
  return unavailableModelIds.has(modelId);
}

// Only free-model families gate free endpoints; non-free unavailable models
// (e.g. region-restricted) must not suppress a family's free endpoints.
const unavailableFreeModelFamilies: ReadonlySet<string> = new Set(
  [...unavailableModelIds].filter(modelId => modelId.endsWith(':free')).map(normalizeModelId)
);

export function familyHasUnavailableFreeModel(modelId: string): boolean {
  return unavailableFreeModelFamilies.has(normalizeModelId(modelId));
}
