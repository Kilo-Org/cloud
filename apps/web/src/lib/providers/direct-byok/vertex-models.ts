import { isGrokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/xai';
import type { GcpVertexEndpoint } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/vertex-byok';
import {
  isUsableModelsDevModel,
  toRawModel,
  type ModelsDevModel,
  type ModelsDevProvider,
  type RawModel,
} from './models-dev';

const VERTEX_ANTHROPIC_SDK = '@ai-sdk/google-vertex/anthropic';
const VERTEX_MISTRAL_SDK = '@ai-sdk/mistral';
const VERTEX_OPENAI_COMPATIBLE_SDK = '@ai-sdk/openai-compatible';

/**
 * Gemini (no per-model SDK) and the managed open and partner models (the
 * OpenAI-compatible SDK) use Vertex AI's Chat Completions endpoint, except
 * Grok, which uses its Responses API so encrypted reasoning round-trips. Claude
 * uses Anthropic's format and Mistral its own Chat Completions, both on
 * `rawPredict` URLs. Returns null for publishers the gateway cannot call.
 */
function selectVertexEndpoint(model: ModelsDevModel): GcpVertexEndpoint | null {
  const npm = model.provider?.npm;
  if (npm === VERTEX_ANTHROPIC_SDK) return 'anthropic';
  if (npm === VERTEX_MISTRAL_SDK) return 'mistral';
  if (npm && npm !== VERTEX_OPENAI_COMPATIBLE_SDK) return null;
  return isGrokModel(model.id) ? 'openapi-responses' : 'openapi';
}

/** One entry per usable Vertex AI model, on the endpoint `selectVertexEndpoint` picks. */
export function parseGcpVertexModelsDevModels({ models }: ModelsDevProvider): RawModel[] {
  return Object.values(models)
    .filter(isUsableModelsDevModel)
    .flatMap(model => {
      const endpoint = selectVertexEndpoint(model);
      return endpoint ? [{ ...toRawModel(model), endpoint }] : [];
    });
}
