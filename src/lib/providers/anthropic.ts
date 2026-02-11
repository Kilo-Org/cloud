import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import { normalizeToolCallIds } from '@/lib/tool-calling';
import type OpenAI from 'openai';

export const CLAUDE_SONNET_CURRENT_MODEL_ID = 'anthropic/claude-sonnet-4.5';

export const CLAUDE_OPUS_CURRENT_MODEL_ID = 'anthropic/claude-opus-4.6';

export const opus_46_free_slackbot_model = {
  public_id: 'anthropic/claude-opus-4.6:slackbot',
  display_name: 'Claude Opus 4.6 (Free for Kilo for Slack)',
  description: 'Free version of Claude Opus 4.6 for use in Kilo for Slack only',
  context_length: 200000,
  max_completion_tokens: 32000,
  is_enabled: true,
  flags: ['reasoning', 'vision'],
  gateway: 'vercel',
  internal_id: 'anthropic/claude-opus-4.6',
  inference_providers: ['anthropic'],
  slackbot_only: true,
} as KiloFreeModel;

const ENABLE_ANTHROPIC_STRICT_TOOL_USE = false;

export function isAnthropicModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/');
}

export function isHaikuModel(requestedModel: string) {
  return requestedModel.startsWith('anthropic/claude-haiku');
}

type ReadFileParametersSchema = {
  properties?: {
    files?: {
      items?: {
        properties?: { line_ranges?: { items?: { minItems?: number; maxItems?: number } } };
      };
    };
  };
};

function patchReadFileTool(func: OpenAI.FunctionDefinition) {
  try {
    const lineRangesItems = (func.parameters as ReadFileParametersSchema | undefined)?.properties
      ?.files?.items?.properties?.line_ranges?.items;
    if (lineRangesItems) {
      delete lineRangesItems.minItems;
      delete lineRangesItems.maxItems;
    }
    func.strict = true;
    return true;
  } catch (e) {
    console.error('[patchReadFileTool]', e);
    return false;
  }
}

function applyAnthropicStrictToolUse(
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  let supportedToolFound = false;
  for (const tool of requestToMutate.tools ?? []) {
    if (tool.type === 'function') {
      if (tool.function.name === 'read_file' && patchReadFileTool(tool.function)) {
        supportedToolFound = true;
      } else {
        delete tool.function.strict;
      }
    }
  }
  if (supportedToolFound) {
    console.debug('[applyAnthropicStrictToolUse] setting structured-outputs beta header');
    extraHeaders['x-anthropic-beta'] = [
      extraHeaders['x-anthropic-beta'],
      'structured-outputs-2025-11-13',
    ]
      .filter(Boolean)
      .join(',');
  }
}

export function applyAnthropicModelSettings(
  requestToMutate: OpenRouterChatCompletionRequest,
  extraHeaders: Record<string, string>
) {
  if (ENABLE_ANTHROPIC_STRICT_TOOL_USE) {
    applyAnthropicStrictToolUse(requestToMutate, extraHeaders);
  }

  // anthropic doesn't allow '.' in tool call ids
  normalizeToolCallIds(requestToMutate, toolCallId => toolCallId.includes('.'), undefined);
}
