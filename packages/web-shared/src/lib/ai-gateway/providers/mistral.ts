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

// Mistral's API rejects any other request or message field with a 422.
const MISTRAL_REQUEST_FIELDS = [
  'model',
  'messages',
  'temperature',
  'top_p',
  'max_tokens',
  'stream',
  'stream_options',
  'stop',
  'random_seed',
  'response_format',
  'tools',
  'tool_choice',
  'presence_penalty',
  'frequency_penalty',
  'n',
  'parallel_tool_calls',
  'prediction',
  'safe_prompt',
];
const MISTRAL_MESSAGE_FIELDS = new Set([
  'role',
  'content',
  'name',
  'tool_calls',
  'tool_call_id',
  'prefix',
]);
/** Mistral's own API accepts these too, unlike Vertex AI's Mistral endpoint. */
const MISTRAL_API_EXTRA_REQUEST_FIELDS = ['reasoning_effort', 'prompt_cache_key'];

function deleteFieldsExcept(value: object, allowed: ReadonlySet<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) Reflect.deleteProperty(value, key);
  }
}

/** Reduces an OpenAI-style Chat Completions body to the fields Mistral's API accepts. */
export function toMistralChatCompletionsBody(body: object, extraFields: readonly string[] = []) {
  const maxCompletionTokens: unknown = Reflect.get(body, 'max_completion_tokens');
  if (Reflect.get(body, 'max_tokens') === undefined && maxCompletionTokens !== undefined) {
    Reflect.set(body, 'max_tokens', maxCompletionTokens);
  }
  const seed: unknown = Reflect.get(body, 'seed');
  if (Reflect.get(body, 'random_seed') === undefined && seed !== undefined) {
    Reflect.set(body, 'random_seed', seed);
  }
  deleteFieldsExcept(body, new Set([...MISTRAL_REQUEST_FIELDS, ...extraFields]));

  const messages: unknown = Reflect.get(body, 'messages');
  for (const message of Array.isArray(messages) ? messages : []) {
    if (isRecord(message)) deleteFieldsExcept(message, MISTRAL_MESSAGE_FIELDS);
  }
  const tools: unknown = Reflect.get(body, 'tools');
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (isRecord(tool) && isRecord(tool.function)) delete tool.function.strict;
  }
}

function reasoningTextOf(message: Record<string, unknown>): string {
  if (Array.isArray(message.reasoning_details)) {
    return message.reasoning_details
      .map(detail =>
        isRecord(detail) &&
        detail.type === ReasoningDetailType.Text &&
        typeof detail.text === 'string'
          ? detail.text
          : ''
      )
      .join('');
  }
  for (const field of ['reasoning_content', 'reasoning']) {
    const value = message[field];
    if (typeof value === 'string') return value;
  }
  return '';
}

function contentChunksOf(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content.length > 0) return [{ type: 'text', text: content }];
  return [];
}

/**
 * Inverse of the Mistral thinking response transform, for Mistral's Chat Completions API:
 * replays assistant reasoning as the `thinking` content chunk Mistral expects back, carries
 * OpenRouter's `reasoning` object over as `reasoning_effort`, and drops every field Mistral
 * rejects.
 */
export function applyMistralThinkingRequestTransform(request: GatewayRequest) {
  if (request.kind !== 'chat_completions') return;
  const body = request.body;
  // Mistral reasons only when asked to, while OpenRouter's reasoning models reason by default.
  body.reasoning_effort = isReasoningExplicitlyDisabled(request)
    ? 'none'
    : (body.reasoning?.effort ?? body.reasoning_effort ?? 'high');

  for (const message of body.messages) {
    if (message.role !== 'assistant') continue;
    const record = message as unknown as Record<string, unknown>;
    const thinking = reasoningTextOf(record);
    if (!thinking) continue;
    record.content = [
      { type: 'thinking', thinking: [{ type: 'text', text: thinking }] },
      ...contentChunksOf(record.content),
    ];
  }
  toMistralChatCompletionsBody(body, MISTRAL_API_EXTRA_REQUEST_FIELDS);
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
