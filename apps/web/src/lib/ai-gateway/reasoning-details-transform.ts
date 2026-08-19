import { ReasoningFormat } from '@/lib/ai-gateway/custom-llm/format';
import {
  type ReasoningDetailEncrypted,
  type ReasoningDetailText,
  ReasoningDetailType,
} from '@/lib/ai-gateway/custom-llm/reasoning-details';
import {
  ReasoningDetailsTransform,
  type ProviderResponseTransforms,
} from '@/lib/ai-gateway/providers/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getGoogleExtraContent(value: Record<string, unknown>) {
  const extraContent = value.extra_content;
  if (!isRecord(extraContent)) {
    return null;
  }
  const google = extraContent.google;
  return isRecord(google) ? google : null;
}

function deleteGoogleExtraContentProperty(value: Record<string, unknown>, property: string) {
  const extraContent = value.extra_content;
  const google = getGoogleExtraContent(value);
  if (!isRecord(extraContent) || !google) {
    return;
  }

  delete google[property];
  if (Object.keys(google).length === 0) {
    delete extraContent.google;
  }
  if (Object.keys(extraContent).length === 0) {
    delete value.extra_content;
  }
}

function mapGeminiThoughtToReasoningDetails(value: unknown) {
  if (!isRecord(value)) {
    return;
  }

  // OpenRouter commonly emits every block with index 0. Its AI SDK provider
  // merges adjacent text by type and always keeps encrypted blocks discrete.
  const details: Array<ReasoningDetailText | ReasoningDetailEncrypted> = [];
  const google = getGoogleExtraContent(value);
  if (typeof value.content === 'string' && google?.thought === true) {
    details.push({
      type: ReasoningDetailType.Text,
      text: value.content,
      index: 0,
      format: ReasoningFormat.GoogleGeminiV1,
    });
    delete value.content;
    deleteGoogleExtraContentProperty(value, 'thought');
  }

  if (typeof google?.thought_signature === 'string') {
    details.push({
      type: ReasoningDetailType.Encrypted,
      data: google.thought_signature,
      index: 0,
      format: ReasoningFormat.GoogleGeminiV1,
    });
    deleteGoogleExtraContentProperty(value, 'thought_signature');
  }

  if (Array.isArray(value.tool_calls)) {
    for (const toolCall of value.tool_calls) {
      if (!isRecord(toolCall)) {
        continue;
      }

      const signature = getGoogleExtraContent(toolCall)?.thought_signature;
      if (typeof signature !== 'string') {
        continue;
      }

      details.push({
        type: ReasoningDetailType.Encrypted,
        data: signature,
        id: typeof toolCall.id === 'string' ? toolCall.id : undefined,
        index: 0,
        format: ReasoningFormat.GoogleGeminiV1,
      });
      deleteGoogleExtraContentProperty(toolCall, 'thought_signature');
    }
  }

  if (details.length > 0) {
    value.reasoning_details = Array.isArray(value.reasoning_details)
      ? [...value.reasoning_details, ...details]
      : details;
  }
}

function mapReasoningContentToDetails(value: unknown) {
  if (
    !isRecord(value) ||
    typeof value.reasoning_content !== 'string' ||
    typeof value.reasoning_details !== 'undefined'
  ) {
    return;
  }

  const detail = {
    type: ReasoningDetailType.Text,
    text: value.reasoning_content,
    index: 0,
    format: ReasoningFormat.Unknown,
  } satisfies ReasoningDetailText;
  value.reasoning_details = [detail];
  delete value.reasoning_content;
}

export function applyReasoningDetailsResponseTransform(
  transform: ProviderResponseTransforms | null,
  value: unknown
) {
  switch (transform) {
    case ReasoningDetailsTransform.GeminiThought:
      mapGeminiThoughtToReasoningDetails(value);
      break;
    case ReasoningDetailsTransform.ReasoningContent:
      mapReasoningContentToDetails(value);
      break;
    case null:
      break;
  }
}
