import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { dropToolStrictProperties } from '@kilocode/web-shared/lib/ai-gateway/tool-calling';
import { isRecord } from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import { isReasoningExplicitlyDisabled } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import { ReasoningFormat } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/format';
import {
  ReasoningDetailType,
  type ReasoningDetailText,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/reasoning-details';

export function isMistralModel(model: string) {
  return model.includes('mistral');
}
export function isCodestralModel(model: string) {
  return model.includes('codestral');
}

export function applyMistralModelSettings(requestToMutate: GatewayRequest) {
  if (requestToMutate.kind !== 'chat_completions') {
    return;
  }

  // mistral recommends this
  // https://kilo-code.slack.com/archives/C09PV151JMN/p1764597849596819
  if (requestToMutate.body.temperature === undefined) {
    requestToMutate.body.temperature = 0.2;
  }

  // mistral doesn't support strict for our schema
  dropToolStrictProperties(requestToMutate.body);
}

function reasoningTextOf(message: Record<string, unknown>): string {
  const detailsText = Array.isArray(message.reasoning_details)
    ? message.reasoning_details
        .map(detail =>
          isRecord(detail) &&
          detail.type === ReasoningDetailType.Text &&
          typeof detail.text === 'string'
            ? detail.text
            : ''
        )
        .join('')
    : '';
  if (detailsText) return detailsText;
  // Details without text, such as only summaries, fall back to the legacy reasoning strings.
  for (const field of ['reasoning_content', 'reasoning']) {
    const value = message[field];
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function contentChunksOf(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content.length > 0) return [{ type: 'text', text: content }];
  return [];
}

/** Message fields that carry reasoning. Mistral rejects them, so their text is replayed as a
 * `thinking` chunk instead. */
const MESSAGE_REASONING_FIELDS = ['reasoning_details', 'reasoning_content', 'reasoning'];

/**
 * Inverse of the Mistral thinking response transform, for Mistral's Chat Completions API:
 * replays assistant reasoning as the `thinking` content chunk Mistral expects back and carries
 * OpenRouter's `reasoning` object over as `reasoning_effort`. Other fields Mistral rejects are
 * left to the definition's `remove_from_body`.
 */
export function applyMistralThinkingRequestTransform(request: GatewayRequest) {
  if (request.kind !== 'chat_completions') return;
  const body = request.body;
  // Mistral reasons only when asked to, while OpenRouter's reasoning models reason by default.
  body.reasoning_effort =
    isReasoningExplicitlyDisabled(request) || body.reasoning?.enabled === false
      ? 'none'
      : (body.reasoning?.effort ?? body.reasoning_effort ?? 'high');
  delete body.reasoning;

  for (const message of body.messages) {
    const record = message as unknown as Record<string, unknown>;
    const thinking = message.role === 'assistant' ? reasoningTextOf(record) : '';
    for (const field of MESSAGE_REASONING_FIELDS) delete record[field];
    if (!thinking) continue;
    record.content = [
      { type: 'thinking', thinking: [{ type: 'text', text: thinking }] },
      ...contentChunksOf(record.content),
    ];
  }
}

/**
 * Mistral sends reasoning as `thinking` chunks in a content list, and streams the answer as
 * text chunks in the same list until it switches to plain string content. Moves the thinking
 * to `reasoning_details` and leaves the answer as a content string.
 */
export function mapMistralThinkingToReasoningDetails(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.content)) return;
  let thinking = '';
  let text = '';
  for (const chunk of value.content) {
    if (!isRecord(chunk)) continue;
    if (chunk.type === 'thinking' && Array.isArray(chunk.thinking)) {
      for (const inner of chunk.thinking) {
        if (isRecord(inner) && typeof inner.text === 'string') thinking += inner.text;
      }
    } else if (chunk.type === 'text' && typeof chunk.text === 'string') {
      text += chunk.text;
    }
  }
  value.content = text.length > 0 ? text : null;
  if (thinking.length > 0) {
    value.reasoning_details = [
      {
        type: ReasoningDetailType.Text,
        text: thinking,
        index: 0,
        format: ReasoningFormat.Unknown,
      } satisfies ReasoningDetailText,
    ];
  }
}
