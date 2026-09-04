import type OpenAI from 'openai';
import { createIs } from 'typia';
import type { Effort, ModelRequest, ModelUsage, StopReason } from '../../../core/model.js';
import type { PromptMessage, PromptPart } from '../../../core/prompt.js';
import type { ToolDefinition } from '../../../core/tool.js';
import { dataUri, resultText } from './parts.js';
import { stopFrom, type Wire, type WirePart } from './wire.js';
import { readCached, type TokenCount } from './usage.js';

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
      readonly content: readonly ContentBlock[];
      readonly tool_calls?: readonly CallBlock[];
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

/**
 * Reasoning is left out. Providers relayed through this shape report their
 * thinking under two different field names and neither takes it back, so there
 * is no block this shape could replay.
 */
const renderPart = (part: PromptPart): ContentBlock | undefined => {
  switch (part.kind) {
    case 'text': {
      return { type: 'text', text: part.text };
    }
    case 'image': {
      return { type: 'image_url', image_url: { url: dataUri(part) } };
    }
    /* None of these is content on this shape. A call is a field on the message
       and a result is a message of its own, both built by `renderMessage`;
       thinking has no form this shape takes back at all. */
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

/**
 * One turn, as the messages this shape takes: what was said, then every result
 * it carried. A turn of nothing but results produces no message of its own,
 * because a message with no content is refused.
 */
const renderMessage = (message: PromptMessage): readonly WireMessage[] => {
  const content = message.parts.map(renderPart).filter(part => part !== undefined);
  const calls = message.parts.map(callBlock).filter(block => block !== undefined);
  const results = message.parts.map(resultMessage).filter(item => item !== undefined);
  const said: readonly WireMessage[] =
    content.length === 0 && calls.length === 0
      ? []
      : [{ role: message.role, content, ...(calls.length === 0 ? {} : { tool_calls: calls }) }];
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

const toBody = ({ prompt, model, maxTokens, effort, tools }: ModelRequest): CompletionsBody => ({
  model,
  max_tokens: maxTokens,
  stream: true,
  stream_options: { include_usage: true },
  ...(effort === undefined ? {} : { reasoning: { effort } }),
  ...(tools === undefined || tools.length === 0 ? {} : { tools: tools.map(toolBlock) }),
  messages: [
    ...prompt.system.map(part => ({
      role: 'system' as const,
      content: [{ type: 'text' as const, text: part.text }],
    })),
    ...prompt.messages.flatMap(renderMessage),
  ],
});

interface Counts {
  prompt_tokens: TokenCount;
  completion_tokens: TokenCount;
  prompt_tokens_details?: { cached_tokens?: TokenCount | null } | null;
}

const stopReasons: Readonly<Record<string, StopReason>> = {
  stop: 'end',
  length: 'maxTokens',
  content_filter: 'refusal',
  tool_calls: 'tools',
};

const asStop = stopFrom(stopReasons);

interface DeltaEvent {
  choices: { delta: { content?: string | null } }[];
}

/**
 * The relayed providers do not agree on a name for the thinking: OpenRouter
 * sends `reasoning` and others send `reasoning_content`, so both are read.
 */
interface ReasoningEvent {
  choices: { delta: { reasoning?: string | null; reasoning_content?: string | null } }[];
}

interface UsageEvent {
  usage: Counts;
}

/** The last content frame of a choice names why that choice ended. */
interface StopEvent {
  choices: { finish_reason: string }[];
}

/**
 * A call, in pieces. The opening frame carries the identifier and the name, and
 * every frame after it carries another fragment of the arguments. Both may sit
 * on the opening frame, so `callStart` takes the fragment with them.
 *
 * There is no frame that closes a call on this shape. The next one opens the
 * next call, and the end of the stream closes the last.
 */
interface CallEvent {
  choices: {
    delta: {
      tool_calls: {
        id?: string | null;
        function?: { name?: string | null; arguments?: string | null } | null;
      }[];
    };
  }[];
}

const isDelta = createIs<DeltaEvent>();
const isCall = createIs<CallEvent>();
const isReasoning = createIs<ReasoningEvent>();
const isUsage = createIs<UsageEvent>();
const isStop = createIs<StopEvent>();

const readUsage = (usage: Counts): Partial<ModelUsage> =>
  readCached(
    usage.prompt_tokens,
    usage.completion_tokens,
    usage.prompt_tokens_details?.cached_tokens ?? 0
  );

/**
 * The empty-choices frame is filtered here rather than in the type. A tuple
 * with a rest element expresses it, but typia then copies the rest on every
 * check, which costs three times as much on the per-token path.
 */
const toDelta = (event: unknown): WirePart | undefined => {
  const said = isDelta(event) ? (event.choices[0]?.delta.content ?? undefined) : undefined;
  if (said !== undefined) {
    return { kind: 'delta', text: said };
  }
  if (!isReasoning(event)) {
    return toCall(event);
  }
  const thought = event.choices[0]?.delta;
  const text = thought?.reasoning ?? thought?.reasoning_content ?? undefined;
  return text === undefined ? toCall(event) : { kind: 'reasoning', text };
};

/** The pieces of a call, kept apart from the per-token path above. */
const toCall = (event: unknown): WirePart | undefined => {
  const call = isCall(event) ? event.choices[0]?.delta.tool_calls[0] : undefined;
  if (call === undefined) {
    return undefined;
  }
  const text = call.function?.arguments ?? undefined;
  if (call.id === undefined || call.id === null) {
    return text === undefined ? undefined : { kind: 'callArguments', text };
  }
  return {
    kind: 'callStart',
    id: call.id,
    name: call.function?.name ?? '',
    ...(text === undefined || text.length === 0 ? {} : { text }),
  };
};

const toUsage = (event: unknown): Partial<ModelUsage> | undefined =>
  isUsage(event) ? readUsage(event.usage) : undefined;

const toStop = (event: unknown): StopReason | undefined =>
  isStop(event) ? asStop(event.choices[0]?.finish_reason) : undefined;

const completionsWire: Wire = {
  path: '/api/gateway/v1/chat/completions',
  toBody,
  toDelta,
  toUsage,
  toStop,
};

export { completionsWire };
