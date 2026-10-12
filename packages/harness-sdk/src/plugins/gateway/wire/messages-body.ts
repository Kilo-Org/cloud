import type Anthropic from '@anthropic-ai/sdk';
import { createAssert, createIs } from 'typia';
import type { Effort, ModelRequest } from '../../../core/model.js';
import type { PromptMessage, PromptPart } from '../../../core/prompt.js';
import type { ToolDefinition } from '../../../core/tool.js';
import { isLast } from './parts.js';

/** The Anthropic types are the contract. `cache_control` marks a breakpoint. */
type ContentBlock =
  | Anthropic.TextBlockParam
  | Anthropic.ImageBlockParam
  | Anthropic.ThinkingBlockParam
  | Anthropic.RedactedThinkingBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam;
type MessagesBody = Anthropic.MessageCreateParams;
type MediaType = Anthropic.Base64ImageSource['media_type'];

const ephemeral = { type: 'ephemeral' } as const;

/**
 * Anthropic names the four image types it takes. The stored media type is a
 * plain string, so it is checked here rather than assumed: an image this shape
 * cannot carry must say so, not be sent and refused.
 */
const assertMedia = createAssert<MediaType>();

/** The system prompt takes text only, so it has a builder of its own. */
const textBlock = (text: string, cache: boolean): Anthropic.TextBlockParam =>
  cache ? { type: 'text', text, cache_control: ephemeral } : { type: 'text', text };

const imageBlock = (media: string, data: string, cache: boolean): ContentBlock => {
  const source = { type: 'base64' as const, media_type: assertMedia(media), data };
  return cache ? { type: 'image', source, cache_control: ephemeral } : { type: 'image', source };
};

/**
 * A thinking block goes back exactly as it came, so it carries no breakpoint of
 * its own: a `cache_control` this package added would be a change to the block.
 */
const thinkingBlock = (text: string, signature: string): Anthropic.ThinkingBlockParam => ({
  type: 'thinking',
  thinking: text,
  signature,
});

/**
 * The arguments as this shape wants them: an object, not the text the model
 * wrote. Text this cannot parse produced a call nothing could run, and its
 * result already says so; an empty object keeps that exchange replayable, where
 * throwing would make the session unusable forever over one bad call.
 */
const argumentsIn = (text: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isArguments(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const isArguments = createIs<Record<string, unknown>>();

const renderPart = (part: PromptPart, cache: boolean): ContentBlock | undefined => {
  switch (part.kind) {
    case 'toolCall': {
      return {
        type: 'tool_use',
        id: part.callId,
        name: part.name,
        input: argumentsIn(part.arguments),
      };
    }
    case 'toolResult': {
      return {
        type: 'tool_result',
        tool_use_id: part.callId,
        content: part.body,
        ...(part.failed ? { is_error: true } : {}),
      };
    }
    case 'text': {
      return textBlock(part.text, cache);
    }
    case 'image': {
      return imageBlock(part.media, part.data, cache);
    }
    case 'reasoning': {
      /* Without a signature the provider refuses the block, so it is left out
         rather than sent and rejected. */
      return part.signature === undefined ? undefined : thinkingBlock(part.text, part.signature);
    }
    case 'redacted': {
      /* Already encrypted by the provider, so it needs no signature and must
         go back byte for byte. */
      return { type: 'redacted_thinking', data: part.data };
    }
  }
};

const renderMessage = (
  message: PromptMessage
): { role: 'user' | 'assistant'; content: ContentBlock[] } => ({
  role: message.role,
  content: message.parts
    .map((part, index) => renderPart(part, isLast(message, index)))
    .filter(block => block !== undefined),
});

/**
 * A tool, as this shape takes one. The schema goes across untouched: nothing
 * here looks inside it, and a shape that rewrote it would change the prefix.
 */
const toolBlock = (tool: ToolDefinition): Anthropic.Tool => ({
  name: tool.name,
  description: tool.description,
  /* Rebuilt only because this SDK types the list as mutable. Every field goes
     across as it was given, which is what the prefix depends on. */
  input_schema: {
    ...tool.parameters,
    type: 'object',
    required: tool.parameters.required === undefined ? [] : [...tool.parameters.required],
  },
});

/**
 * The effort, as this shape takes it. It turns thinking off rather than taking
 * `none`, and it names no `minimal`: `low` is the nearest level it takes.
 */
const effortFields = (
  effort: Effort | undefined
): Pick<MessagesBody, 'thinking' | 'output_config'> => {
  if (effort === undefined) {
    return {};
  }
  if (effort === 'none') {
    return { thinking: { type: 'disabled' } };
  }
  return { output_config: { effort: effort === 'minimal' ? 'low' : effort } };
};

/* Typed `unknown` outward, as `completions-body.ts` is: the declaration must not
   name the Anthropic package, which a consumer does not install. */
const toBody = ({ prompt, model, maxTokens, effort, tools }: ModelRequest): unknown =>
  ({
    model,
    max_tokens: maxTokens,
    stream: true,
    ...effortFields(effort),
    /* Left out rather than sent empty: a shape that is offered no tool must not
     be told there is an empty list of them, and an empty list would sit in the
     prefix of a session that has none. */
    ...(tools === undefined || tools.length === 0 ? {} : { tools: tools.map(toolBlock) }),
    system: prompt.system.map(part => textBlock(part.text, part.cache)),
    messages: prompt.messages.map(renderMessage),
  }) satisfies MessagesBody;

export { toBody };
