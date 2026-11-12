import { createParser } from 'eventsource-parser';
import * as z from 'zod';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';

export type ResponseBodyFormat = 'sse' | 'json';

type Text = string | null | undefined;

/**
 * Collects text in groups, such as one content block or one tool call's arguments, so pieces that
 * arrive in interleaved stream deltas are joined in their own order. Groups keep the order in which
 * they first appeared, and identical groups, such as a finished item repeating its deltas, are
 * scanned once.
 */
function createTextGroups() {
  const groups = new Map<string, string[]>();
  let ungrouped = 0;
  const add = (key: string, text: Text) => {
    if (!text) return;
    const group = groups.get(key);
    if (group) group.push(text);
    else groups.set(key, [text]);
  };
  return {
    add,
    addUngrouped: (text: string) => add(`ungrouped:${ungrouped++}`, text),
    text: () =>
      [
        ...new Set(
          [...groups.values()].flatMap(pieces => {
            const text = pieces.join('').trim();
            return text ? [text] : [];
          })
        ),
      ].join('\n\n'),
  };
}

type TextGroups = ReturnType<typeof createTextGroups>;

/** Returns false when the JSON does not have the expected shape. */
type AddJson = (groups: TextGroups, json: unknown) => boolean;

const text = z.string().nullish();

/** Tool inputs are scanned as the JSON the client receives. */
function jsonText(value: unknown): Text {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object' || Object.keys(value).length === 0) {
    return undefined;
  }
  return JSON.stringify(value);
}

/** Identifiers, encrypted content, signatures, and tool results that the model did not write. */
const NOT_MODEL_WRITTEN_FIELDS = new Set([
  'id',
  'call_id',
  'status',
  'encrypted_content',
  'signature',
  'data',
  'output',
  'outputs',
  'result',
  'results',
  'error',
]);

/**
 * Fields never scanned: those the model did not write, signatures and encrypted content under any
 * name, such as `reasoning_signature`, and reasoning summaries, which restate the raw reasoning and
 * are not fed back to the model.
 */
function isScannedField(key: string): boolean {
  return !NOT_MODEL_WRITTEN_FIELDS.has(key) && !/summary|signature|encrypted/i.test(key);
}

/**
 * Output types the gateway does not know yet, such as new tool calls, are scanned as JSON so that
 * they are checked rather than skipped.
 */
function unknownOutputText(value: Record<string, unknown>): Text {
  return jsonText(Object.fromEntries(Object.entries(value).filter(([key]) => isScannedField(key))));
}

const chatMessageSchema = z.looseObject({
  content: z
    .union([z.string(), z.array(z.object({ type: z.string(), text, refusal: text }))])
    .nullish(),
  refusal: text,
  reasoning: text,
  reasoning_content: text,
  reasoning_details: z.array(z.object({ type: z.string(), text })).nullish(),
  tool_calls: z
    .array(
      z.object({
        index: z.number().optional(),
        function: z.object({ name: text, arguments: text }).nullish(),
        custom: z.object({ name: text, input: text }).nullish(),
      })
    )
    .nullish(),
  function_call: z.object({ name: text, arguments: text }).nullish(),
});

type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * Message fields read above, and those that are not model output: the role, and annotations, such
 * as citations of web search results.
 */
const KNOWN_CHAT_MESSAGE_FIELDS = new Set([
  ...Object.keys(chatMessageSchema.shape),
  'role',
  'annotations',
]);

/**
 * Adds the strings of a value the gateway does not know, each under its path, so text streamed in
 * pieces across deltas, such as an audio transcript, joins in order like `content`. Type tags are
 * not model output, and data URLs, such as generated images or audio, are not text, so neither is
 * scanned.
 */
function addUnknownStrings(groups: TextGroups, path: string, value: unknown) {
  if (typeof value === 'string') {
    if (!value.startsWith('data:')) groups.add(path, value);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => addUnknownStrings(groups, `${path}.${index}`, item));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key !== 'type' && isScannedField(key)) addUnknownStrings(groups, `${path}.${key}`, item);
    }
  }
}

const chatCompletionSchema = z.object({
  choices: z.array(
    z.object({ index: z.number().optional(), message: chatMessageSchema.nullish() })
  ),
});

const chatChunkSchema = z.object({
  choices: z
    .array(z.object({ index: z.number().optional(), delta: chatMessageSchema.nullish() }))
    .nullish(),
});

/**
 * Providers often send the same reasoning in several fields, so identical copies are scanned once.
 * Reasoning summaries restate the raw reasoning, and encrypted reasoning cannot be read, so neither
 * is scanned.
 */
function chatReasoning(message: ChatMessage): Text {
  const details = (message.reasoning_details ?? [])
    .map(detail => {
      if (detail.type === 'reasoning.text') return detail.text ?? '';
      return '';
    })
    .join('');
  return [...new Set([message.reasoning, message.reasoning_content, details])]
    .filter(Boolean)
    .join('');
}

function addChatMessage(groups: TextGroups, choice: string, message: ChatMessage) {
  groups.add(`${choice}:reasoning`, chatReasoning(message));
  const { content } = message;
  if (typeof content === 'string') groups.add(`${choice}:content`, content);
  else {
    for (const part of content ?? []) {
      groups.add(`${choice}:content`, part.type === 'refusal' ? part.refusal : part.text);
    }
  }
  groups.add(`${choice}:refusal`, message.refusal);
  groups.add(`${choice}:function:name`, message.function_call?.name);
  groups.add(`${choice}:function:arguments`, message.function_call?.arguments);
  (message.tool_calls ?? []).forEach((call, position) => {
    const tool = `${choice}:tool:${call.index ?? position}`;
    groups.add(`${tool}:name`, call.function?.name ?? call.custom?.name);
    groups.add(`${tool}:arguments`, call.function?.arguments ?? call.custom?.input);
  });
  // Fields the gateway does not know yet, such as an audio transcript, still reach the client.
  for (const [key, value] of Object.entries(message)) {
    if (!KNOWN_CHAT_MESSAGE_FIELDS.has(key) && isScannedField(key)) {
      addUnknownStrings(groups, `${choice}:extra:${key}`, value);
    }
  }
}

const addChatCompletion: AddJson = (groups, json) => {
  const parsed = chatCompletionSchema.safeParse(json);
  if (!parsed.success) return false;
  parsed.data.choices.forEach((choice, position) => {
    if (choice.message)
      addChatMessage(groups, `choice:${choice.index ?? position}`, choice.message);
  });
  return true;
};

const addChatChunk: AddJson = (groups, json) => {
  const parsed = chatChunkSchema.safeParse(json);
  if (!parsed.success) return false;
  (parsed.data.choices ?? []).forEach((choice, position) => {
    if (choice.delta) addChatMessage(groups, `choice:${choice.index ?? position}`, choice.delta);
  });
  return true;
};

const anthropicBlockSchema = z.looseObject({
  type: z.string(),
  text,
  thinking: text,
  name: text,
  input: z.unknown().optional(),
});

type AnthropicBlock = z.infer<typeof anthropicBlockSchema>;

/** Redacted thinking is encrypted, and server tool results are not model output. */
function addAnthropicBlock(groups: TextGroups, key: string, block: AnthropicBlock) {
  switch (block.type) {
    case 'text':
      groups.add(key, block.text);
      return;
    case 'thinking':
      groups.add(key, block.thinking);
      return;
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use':
      groups.add(`${key}:name`, block.name);
      groups.add(key, jsonText(block.input));
      return;
    case 'redacted_thinking':
    case 'container_upload':
      return;
    default:
      if (!block.type.endsWith('_result')) groups.add(key, unknownOutputText(block));
  }
}

const addMessage: AddJson = (groups, json) => {
  const parsed = z.object({ content: z.array(anthropicBlockSchema) }).safeParse(json);
  if (!parsed.success) return false;
  parsed.data.content.forEach((block, index) => addAnthropicBlock(groups, `block:${index}`, block));
  return true;
};

const messagesEventSchema = z.object({
  type: z.string(),
  index: z.number().optional(),
  content_block: anthropicBlockSchema.optional(),
  delta: z
    .object({ type: z.string().optional(), text, thinking: text, partial_json: text })
    .optional(),
});

const addMessagesEvent: AddJson = (groups, json) => {
  const parsed = messagesEventSchema.safeParse(json);
  if (!parsed.success) return false;
  const { type, content_block, delta } = parsed.data;
  const key = `block:${parsed.data.index ?? 0}`;
  if (type === 'content_block_start' && content_block) {
    addAnthropicBlock(groups, key, content_block);
  }
  if (type === 'content_block_delta' && delta) {
    if (delta.type === 'text_delta') groups.add(key, delta.text);
    if (delta.type === 'thinking_delta') groups.add(key, delta.thinking);
    if (delta.type === 'input_json_delta') groups.add(key, delta.partial_json);
  }
  return true;
};

const responsesItemSchema = z.looseObject({
  type: z.string(),
  name: text,
  arguments: text,
  input: text,
  content: z.array(z.object({ type: z.string(), text, refusal: text })).nullish(),
});

type ResponsesItem = z.infer<typeof responsesItemSchema>;

/**
 * Reasoning items carry their encrypted content and their summary in fields that are never
 * scanned, and tool results are not model output.
 */
function addResponsesItem(groups: TextGroups, key: string, item: ResponsesItem) {
  switch (item.type) {
    case 'message':
    case 'reasoning':
      (item.content ?? []).forEach((part, index) =>
        groups.add(`${key}:content:${index}`, part.type === 'refusal' ? part.refusal : part.text)
      );
      return;
    case 'function_call':
    case 'mcp_call':
      groups.add(`${key}:name`, item.name);
      groups.add(`${key}:arguments`, item.arguments);
      return;
    case 'custom_tool_call':
      groups.add(`${key}:name`, item.name);
      groups.add(`${key}:arguments`, item.input);
      return;
    default:
      groups.add(key, unknownOutputText(item));
  }
}

const addResponse: AddJson = (groups, json) => {
  const parsed = z.object({ output: z.array(responsesItemSchema) }).safeParse(json);
  if (!parsed.success) return false;
  parsed.data.output.forEach((item, index) => addResponsesItem(groups, `output:${index}`, item));
  return true;
};

const RESPONSES_DELTA_GROUPS = new Map([
  ['response.output_text.delta', 'content'],
  ['response.refusal.delta', 'content'],
  ['response.reasoning_text.delta', 'content'],
  ['response.reasoning.delta', 'content'],
  ['response.function_call_arguments.delta', 'arguments'],
  ['response.custom_tool_call_input.delta', 'arguments'],
  ['response.mcp_call_arguments.delta', 'arguments'],
]);

const responsesEventSchema = z.object({
  type: z.string(),
  output_index: z.number().optional(),
  content_index: z.number().optional(),
  delta: z.unknown().optional(),
  item: responsesItemSchema.optional(),
});

/**
 * A finished output item is what clients act on, and its deltas are what they display, so both are
 * scanned. A finished reasoning item can carry only encrypted content while its text arrived as
 * deltas, and deltas still cover an item whose stream was cut off before it finished.
 */
const addResponsesEvent: AddJson = (groups, json) => {
  const parsed = responsesEventSchema.safeParse(json);
  if (!parsed.success) return false;
  const event = parsed.data;
  const key = `output:${event.output_index ?? 0}`;
  if (event.type === 'response.output_item.added' && event.item) {
    groups.add(`${key}:name`, event.item.name);
  }
  if (event.type === 'response.output_item.done' && event.item) {
    addResponsesItem(groups, `${key}:item`, event.item);
    return true;
  }
  const group = RESPONSES_DELTA_GROUPS.get(event.type);
  if (group === 'arguments' && typeof event.delta === 'string') {
    groups.add(`${key}:arguments`, event.delta);
  } else if (group && typeof event.delta === 'string') {
    groups.add(`${key}:${group}:${event.content_index ?? 0}`, event.delta);
  }
  return true;
};

const EXTRACTORS: Record<GatewayChatApiKind, Record<ResponseBodyFormat, AddJson>> = {
  chat_completions: { json: addChatCompletion, sse: addChatChunk },
  messages: { json: addMessage, sse: addMessagesEvent },
  responses: { json: addResponse, sse: addResponsesEvent },
};

/** Text that cannot be parsed into the expected shape is scanned whole, so no output escapes. */
function addJson(groups: TextGroups, data: string, add: AddJson) {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    groups.addUngrouped(data);
    return;
  }
  if (!add(groups, json)) groups.addUngrouped(data);
}

/**
 * The text of an upstream model response that reaches the client: assistant text and refusals,
 * raw reasoning, and tool-call names and arguments, which clients execute and
 * which can carry the same content as text. Response metadata, usage, and server tool results are
 * not scanned.
 */
export function extractResponseText(
  kind: GatewayChatApiKind,
  format: ResponseBodyFormat,
  body: string
): string {
  const groups = createTextGroups();
  const add = EXTRACTORS[kind][format];
  if (format === 'json') {
    addJson(groups, body, add);
    return groups.text();
  }
  const parser = createParser({
    onEvent: event => {
      if (event.data !== '[DONE]') addJson(groups, event.data, add);
    },
  });
  parser.feed(body);
  parser.reset({ consume: true });
  return groups.text();
}
