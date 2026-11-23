import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createVercelProviderMetadataCollector() {
  let metadata: Record<string, unknown> | undefined;
  let terminal = false;
  let kind: GatewayChatApiKind | undefined;
  const { promise: completed, resolve: complete } = Promise.withResolvers<void>();

  const captureNode = (value: unknown) => {
    if (!isRecord(value)) return;
    const candidate = value.provider_metadata ?? value.providerMetadata;
    if (isRecord(candidate)) metadata = candidate;
  };

  const resolveKind = (
    value: Record<string, unknown>,
    apiKind?: GatewayChatApiKind
  ): GatewayChatApiKind | undefined => {
    if (apiKind !== undefined) {
      kind = apiKind;
      return apiKind;
    }
    if (kind === undefined) {
      if (value.type === 'message_start') kind = 'messages';
      else if (isRecord(value.response)) kind = 'responses';
      else if (Array.isArray(value.choices)) kind = 'chat_completions';
    }
    return kind;
  };

  return {
    completed,
    capture(value: unknown, suppliedApiKind?: GatewayChatApiKind) {
      if (terminal) return;
      if (value === '[DONE]') {
        terminal = true;
        complete();
        return;
      }
      if (!isRecord(value)) return;

      const apiKind = resolveKind(value, suppliedApiKind);

      if (apiKind === 'messages') {
        if (value.type === 'message_start') captureNode(value.message);
        captureNode(value);
      } else if (apiKind === 'responses') {
        captureNode(value.response);
        captureNode(value);
      } else {
        const choices = Array.isArray(value.choices) ? value.choices : [];
        for (const choice of choices) {
          if (isRecord(choice)) captureNode(choice.delta);
        }
        captureNode(value);
        for (const choice of choices) {
          if (isRecord(choice)) captureNode(choice.message);
        }
      }

      terminal =
        (apiKind === 'chat_completions' && value.error != null) ||
        (apiKind === 'messages' && (value.type === 'message_stop' || value.type === 'error')) ||
        (apiKind === 'responses' &&
          (value.type === 'response.completed' ||
            value.type === 'response.failed' ||
            value.type === 'response.incomplete' ||
            value.type === 'error'));
      if (terminal) complete();
    },
    snapshot(): Record<string, unknown> | undefined {
      return metadata;
    },
  };
}
