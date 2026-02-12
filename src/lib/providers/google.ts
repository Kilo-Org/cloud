import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import type { ProviderId } from '@/lib/providers/provider-id';

export function isGeminiModel(model: string) {
  return model.startsWith('google/gemini');
}

type ReadFileParametersSchema = {
  properties?: {
    files?: {
      items?: {
        properties?: {
          line_ranges?: {
            type?: unknown;
            items?: unknown;
            anyOf?: unknown;
          };
        };
      };
    };
  };
};

export function applyGoogleModelSettings(
  provider: ProviderId,
  requestToMutate: OpenRouterChatCompletionRequest
) {
  if (provider !== 'vercel') {
    return;
  }

  const readFileTool = requestToMutate.tools?.find(
    tool => tool.type === 'function' && tool.function.name === 'read_file'
  );
  if (!readFileTool || readFileTool.type !== 'function') {
    return;
  }

  const lineRanges = (readFileTool.function.parameters as ReadFileParametersSchema | undefined)
    ?.properties?.files?.items?.properties?.line_ranges;
  if (lineRanges?.type && lineRanges?.items) {
    lineRanges.anyOf = [{ type: 'null' }, { type: 'array', items: lineRanges.items }];
    delete lineRanges.type;
    delete lineRanges.items;
  }
}
