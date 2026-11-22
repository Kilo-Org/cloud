import type { OpenRouterChatCompletionRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { isRecord } from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import { ReasoningFormat } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/format';
import { ReasoningDetailType } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/reasoning-details';
import { GEMINI_THOUGHT_TAG_MARKER } from '@kilocode/web-shared/lib/ai-gateway/reasoning-details-transform';

function setGeminiThoughtSignature(value: Record<string, unknown>, signature: string) {
  const extraContent = isRecord(value.extra_content) ? value.extra_content : {};
  const google = isRecord(extraContent.google) ? extraContent.google : {};
  value.extra_content = {
    ...extraContent,
    google: {
      ...google,
      thought_signature: signature,
    },
  };
}

function mapGeminiReasoningDetails(request: OpenRouterChatCompletionRequest) {
  for (const message of request.messages) {
    if (!isRecord(message)) {
      continue;
    }

    delete message.thoughtSignature;
    delete message.reasoning;

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : [];
    const toolCallsById = new Map<string, Record<string, unknown>>();
    for (const toolCall of toolCalls) {
      const legacySignature = toolCall.thoughtSignature;
      delete toolCall.thoughtSignature;
      if (typeof legacySignature === 'string') {
        setGeminiThoughtSignature(toolCall, legacySignature);
      }
      // First write wins, so a duplicate id keeps the earliest tool call.
      if (typeof toolCall.id === 'string' && !toolCallsById.has(toolCall.id)) {
        toolCallsById.set(toolCall.id, toolCall);
      }
    }

    const reasoningDetails = message.reasoning_details;
    delete message.reasoning_details;
    if (!Array.isArray(reasoningDetails)) {
      continue;
    }

    for (const detail of reasoningDetails) {
      if (
        !isRecord(detail) ||
        detail.type !== ReasoningDetailType.Encrypted ||
        typeof detail.data !== 'string' ||
        detail.format !== ReasoningFormat.GoogleGeminiV1
      ) {
        continue;
      }

      const toolCall = typeof detail.id === 'string' ? toolCallsById.get(detail.id) : undefined;
      setGeminiThoughtSignature(toolCall ?? message, detail.data);
    }
  }
}

export function applyGeminiReasoningRequestTransform(request: OpenRouterChatCompletionRequest) {
  const reasoningEffort = request.reasoning_effort;
  const extra = request as typeof request & { google?: unknown };
  delete extra.reasoning_effort;

  if (reasoningEffort !== 'none') {
    const existingGoogle = isRecord(extra.google) ? extra.google : {};
    extra.google = {
      ...existingGoogle,
      thinking_config: {
        ...(reasoningEffort !== undefined ? { thinking_level: reasoningEffort } : {}),
        include_thoughts: true,
      },
      // Without streaming, thoughts and answer share one content string, and
      // only these tags separate them. Streams flag thought chunks instead, and
      // asking for tags there would also put the closing tag in the answer.
      ...(request.stream !== true ? { thought_tag_marker: GEMINI_THOUGHT_TAG_MARKER } : {}),
    };
  }

  mapGeminiReasoningDetails(request);
}
