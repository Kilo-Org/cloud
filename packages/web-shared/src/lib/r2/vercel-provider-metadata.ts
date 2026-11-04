import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createVercelProviderMetadataCollector() {
  let metadata: Record<string, unknown> | undefined;
  let terminal = false;
  const { promise: completed, resolve: complete } = Promise.withResolvers<void>();

  const captureNode = (value: unknown) => {
    if (!isRecord(value)) return;
    const candidate = value.provider_metadata ?? value.providerMetadata;
    if (isRecord(candidate)) metadata = candidate;
  };

  return {
    completed,
    capture(value: unknown, apiKind?: GatewayChatApiKind) {
      if (terminal) return;
      if (value === '[DONE]') {
        terminal = true;
        complete();
        return;
      }
      if (!isRecord(value)) return;

      if (apiKind === 'messages' || (apiKind === undefined && value.type === 'message_start')) {
        if (value.type === 'message_start') captureNode(value.message);
        captureNode(value);
      } else if (apiKind === 'responses' || (apiKind === undefined && isRecord(value.response))) {
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
