import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';

export function isGeminiModel(model: string) {
  return model.startsWith('google/gemini');
}

export function isGemini3Model(model: string) {
  return model.startsWith('google/gemini-3');
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

export function applyGoogleModelSettings(provider: ProviderId, requestToMutate: GatewayRequest) {
  if (provider !== 'vercel' || requestToMutate.kind !== 'chat_completions') {
    // these are workarounds for the old extension, which won't support the responses api
    return;
  }

  const readFileTool = requestToMutate.body.tools?.find(
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
