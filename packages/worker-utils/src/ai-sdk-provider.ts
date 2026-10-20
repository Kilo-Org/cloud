import type { CustomLlmProvider } from '@kilocode/db/schema-types';
import {
  isClaudeModel,
  isGrokModel,
  isMinimaxModel,
  isMuseModel,
  isOpenAiModel,
  isQwenModel,
} from './model-families';

/**
 * The AI SDK provider Kilo clients use to call a gateway model, advertised to
 * them as `opencode.ai_sdk_provider` in the model catalog. `undefined` means
 * the default OpenRouter provider.
 */
export function getAiSdkProvider(
  model: string,
  directProviderId: string | null
): Exclude<CustomLlmProvider, 'openrouter' /*the default*/> | undefined {
  if (directProviderId === 'morph-byok') {
    return undefined;
  }
  if (directProviderId === 'opencode-go' && (isMinimaxModel(model) || isQwenModel(model))) {
    return 'anthropic';
  }
  if (isClaudeModel(model)) {
    return 'anthropic';
  }
  if (isOpenAiModel(model) || isGrokModel(model) || isMuseModel(model)) {
    // OpenAI: "While Chat Completions remains supported, Responses is recommended for all new projects."
    // xAI: "The Responses API is the recommended way to interact with xAI models."
    return 'openai';
  }
  return undefined;
}
