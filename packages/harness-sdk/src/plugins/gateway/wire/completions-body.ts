import type OpenAI from 'openai';
import type { Effort, ModelRequest } from '../../../core/model.js';
import type { PromptMessage, PromptPart } from '../../../core/prompt.js';
import type { ToolDefinition } from '../../../core/tool.js';
import { dataUri, resultText } from './parts.js';

/**
 * The OpenAI chat shape, with one extension for the effort.
 *
 * It marks no cache breakpoint. It used to send Anthropic's `cache_control` on
 * the last block, on the theory that the gateway would forward it to a provider
 * that reads it. Measured on 2026-09-04 against a prefix nobody had sent
 * before, twice for `openai/gpt-5.6-luna` and twice for
 * `anthropic/claude-haiku-4.5`: the second call read 12229 and 13630 cached
 * tokens, the same to the token with the breakpoint and without it. This shape
 * caches on whatever the gateway does, which is what `api-kind.ts` ranks it on.
 */
type CompletionsBody = Omit<OpenAI.Chat.ChatCompletionCreateParams, 'messages'> & {
  /** The OpenRouter reasoning field. It is not part of the OpenAI type. */
  readonly reasoning?: { readonly effort: Effort };
  readonly messages: readonly WireMessage[];
};

/**
 * A message, as this shape takes one.
 *
 * A tool result is a message of its own here, with a role of its own, where
 * both other shapes carry it as content inside a message. A call is a field on
 * the assistant's message rather than a block in it, for the same reason: this
 * shape was built before a message could hold anything but words.
 */
type WireMessage =
  | {
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string | readonly ContentBlock[];
      readonly tool_calls?: readonly CallBlock[];
      readonly reasoning_content?: string;
    }
  | { readonly role: 'tool'; readonly tool_call_id: string; readonly content: string };

type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

/** A call, as this shape takes one. The arguments stay the text the model wrote. */
interface CallBlock {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

/** Reasoning is not content; direct assistant turns replay it as reasoning_content. */
const renderPart = (part: PromptPart): ContentBlock | undefined => {
  switch (part.kind) {
    case 'text': {
      return { type: 'text', text: part.text };
    }
    case 'image': {
      return { type: 'image_url', image_url: { url: dataUri(part) } };
    }
    /* Calls and results are rendered separately, as is direct assistant reasoning. */
    case 'reasoning':
    case 'redacted':
    case 'toolCall':
    case 'toolResult': {
      return undefined;
    }
  }
};

const callBlock = (part: PromptPart): CallBlock | undefined =>
  part.kind === 'toolCall'
    ? {
        id: part.callId,
        type: 'function',
        function: { name: part.name, arguments: part.arguments },
      }
    : undefined;

/**
 * A result is its own message here, one per result, and it must follow the
 * message that made the call. The turns arrive in order, so it does.
 *
 * There is no flag for a failed result, so the text says so instead.
 */
const resultMessage = (part: PromptPart): WireMessage | undefined =>
  part.kind === 'toolResult'
    ? {
        role: 'tool',
        tool_call_id: part.callId,
        content: resultText(part.body, part.failed),
      }
    : undefined;

const reasoningIn = (parts: readonly PromptPart[]): string | undefined => {
  let text = '';
  let present = false;
  for (const part of parts) {
    if (part.kind === 'reasoning') {
      present = true;
      text += part.text;
    }
  }
  return present ? text : undefined;
};

/**
 * One turn, as the messages this shape takes: what was said, then every result
 * it carried. A turn of nothing but results produces no message of its own,
 * because a message with no content is refused.
 */
const renderMessage = (message: PromptMessage, plainText = false): readonly WireMessage[] => {
  const content = message.parts.map(renderPart).filter(part => part !== undefined);
  const calls = message.parts.map(callBlock).filter(block => block !== undefined);
  const results = message.parts.map(resultMessage).filter(item => item !== undefined);
  const rendered =
    plainText && content.every(part => part.type === 'text')
      ? content.map(part => part.text).join('')
      : content;
  const reasoning =
    plainText && message.role === 'assistant' ? reasoningIn(message.parts) : undefined;
  const said: readonly WireMessage[] =
    content.length === 0 && calls.length === 0 && reasoning === undefined
      ? []
      : [
          {
            role: message.role,
            content: rendered,
            ...(calls.length === 0 ? {} : { tool_calls: calls }),
            ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
          },
        ];
  return [...said, ...results];
};

/** A tool, as this shape takes one: a function, wrapped in an envelope. */
const toolBlock = (tool: ToolDefinition): OpenAI.Chat.ChatCompletionTool => ({
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,
    parameters: { ...tool.parameters },
  },
});

const effortFields = (
  effort: Effort | undefined,
  remote: boolean
): Pick<CompletionsBody, 'reasoning' | 'reasoning_effort'> => {
  if (effort === undefined) {
    return {};
  }
  if (!remote) {
    return { reasoning: { effort } };
  }
  if (effort === 'max') {
    throw new Error('Unsupported reasoning effort');
  }
  return { reasoning_effort: effort };
};

const toBody = (
  { prompt, model, maxTokens, effort, tools }: ModelRequest,
  remote = false,
  completionTokenField: 'max_completion_tokens' | 'max_tokens' = 'max_completion_tokens'
): unknown =>
  ({
    model,
    [remote ? completionTokenField : 'max_tokens']: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...effortFields(effort, remote),
    ...(tools === undefined || tools.length === 0 ? {} : { tools: tools.map(toolBlock) }),
    messages: [
      ...prompt.system.map(part => ({
        role: 'system' as const,
        content: remote ? part.text : [{ type: 'text' as const, text: part.text }],
      })),
      ...prompt.messages.flatMap(message => renderMessage(message, remote)),
    ],
  }) satisfies CompletionsBody;

const remoteCompletionsBody = (
  request: ModelRequest,
  completionTokenField: 'max_completion_tokens' | 'max_tokens' = 'max_completion_tokens'
): unknown => toBody(request, true, completionTokenField);

export { toBody, remoteCompletionsBody };
