import {
  MirrorPayloadSchema,
  type JsonValue,
  type MirrorPayload,
  type NormalizedClassifierInput,
} from '@kilocode/auto-routing-contracts';
import * as z from 'zod';

const TEXT_PREFIX_MAX_LENGTH = 1000;
const REDACTED_VALUE = '[REDACTED]';
const SENSITIVE_KEY_PATTERNS = [
  'authorization',
  'api_key',
  'apikey',
  'cookie',
  'credential',
  'password',
  'secret',
  'token',
];
const REDUNDANT_CONTENT_TYPES = new Set([
  'function_call_output',
  'tool_call_output',
  'tool_result',
]);

export const mirrorPayloadSchema = MirrorPayloadSchema;

const modelSchema = z.string().trim().min(1);
const messageSchema = z.looseObject({
  role: z.string(),
  content: z.unknown().optional(),
});

const commonBodySchema = {
  model: modelSchema,
  stream: z.boolean().optional(),
  provider: z.unknown().optional(),
  providerOptions: z.unknown().optional(),
  tools: z.array(z.unknown()).optional(),
};

const chatCompletionBodySchema = z.looseObject({
  ...commonBodySchema,
  messages: z.array(messageSchema),
});

const responsesBodySchema = z.looseObject({
  ...commonBodySchema,
  input: z.unknown().optional(),
  instructions: z.unknown().optional(),
});

const messagesBodySchema = z.looseObject({
  ...commonBodySchema,
  system: z.unknown().optional(),
  messages: z.array(messageSchema),
});

export type { NormalizedClassifierInput };

export type ClassifierInputParseResult =
  | { success: true; data: NormalizedClassifierInput }
  | { success: false; error: 'Invalid mirrored request body' | 'Invalid classifier body' };

type Message = z.infer<typeof messageSchema>;
type ProviderHintSource = {
  provider?: unknown;
  providerOptions?: unknown;
};

export function parseClassifierInput(payload: MirrorPayload): ClassifierInputParseResult {
  let mirroredBody: unknown;
  try {
    mirroredBody = JSON.parse(payload.body);
  } catch {
    return { success: false, error: 'Invalid mirrored request body' };
  }

  if (payload.path === '/chat/completions') {
    const parsed = chatCompletionBodySchema.safeParse(mirroredBody);
    if (!parsed.success) {
      return { success: false, error: 'Invalid classifier body' };
    }

    return {
      success: true,
      data: {
        apiKind: 'chat_completions',
        requestedModel: parsed.data.model,
        systemPromptPrefix: firstPromptPrefix(parsed.data.messages, 'system'),
        userPromptPrefix: firstPromptPrefix(parsed.data.messages, 'user'),
        latestUserPromptPrefix: latestPromptPrefix(parsed.data.messages, 'user'),
        messageCount: parsed.data.messages.length,
        hasTools: hasTools(parsed.data.tools),
        stream: parsed.data.stream === true,
        providerHints: providerHints(parsed.data),
      },
    };
  }

  if (payload.path === '/responses') {
    const parsed = responsesBodySchema.safeParse(mirroredBody);
    if (!parsed.success) {
      return { success: false, error: 'Invalid classifier body' };
    }

    const inputMessages = inputToMessages(parsed.data.input);
    const inputTextPrefix = textPrefix(parsed.data.input);

    return {
      success: true,
      data: {
        apiKind: 'responses',
        requestedModel: parsed.data.model,
        systemPromptPrefix:
          textPrefix(parsed.data.instructions) ?? firstPromptPrefix(inputMessages, 'system'),
        userPromptPrefix: firstPromptPrefix(inputMessages, 'user') ?? inputTextPrefix,
        latestUserPromptPrefix: latestPromptPrefix(inputMessages, 'user'),
        messageCount: messageCount(parsed.data.input),
        hasTools: hasTools(parsed.data.tools),
        stream: parsed.data.stream === true,
        providerHints: providerHints(parsed.data),
      },
    };
  }

  const parsed = messagesBodySchema.safeParse(mirroredBody);
  if (!parsed.success) {
    return { success: false, error: 'Invalid classifier body' };
  }

  return {
    success: true,
    data: {
      apiKind: 'messages',
      requestedModel: parsed.data.model,
      systemPromptPrefix:
        textPrefix(parsed.data.system) ?? firstPromptPrefix(parsed.data.messages, 'system'),
      userPromptPrefix: firstPromptPrefix(parsed.data.messages, 'user'),
      latestUserPromptPrefix: latestPromptPrefix(parsed.data.messages, 'user'),
      messageCount: parsed.data.messages.length,
      hasTools: hasTools(parsed.data.tools),
      stream: parsed.data.stream === true,
      providerHints: providerHints(parsed.data),
    },
  };
}

function inputToMessages(input: unknown): Message[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.flatMap(item => {
    if (!isRecord(item) || typeof item.role !== 'string') {
      return [];
    }

    return [{ role: item.role, content: item.content }];
  });
}

function messageCount(input: unknown) {
  if (Array.isArray(input)) {
    return input.length;
  }

  if (typeof input === 'string') {
    return 1;
  }

  return null;
}

function firstPromptPrefix(messages: Message[], role: string) {
  return promptPrefixes(messages, role)[0] ?? null;
}

function latestPromptPrefix(messages: Message[], role: string) {
  const prefixes = promptPrefixes(messages, role);
  const first = prefixes[0] ?? null;
  const latest = prefixes.at(-1) ?? null;

  return latest && latest !== first ? latest : null;
}

function promptPrefixes(messages: Message[], role: string) {
  return messages.flatMap(item => {
    if (item.role !== role) {
      return [];
    }

    const prefix = textPrefix(item.content);
    return prefix ? [prefix] : [];
  });
}

function textPrefix(value: unknown): string | null {
  const text = cleanPromptText(textFromValue(value));

  if (text.length === 0) {
    return null;
  }

  return text.slice(0, TEXT_PREFIX_MAX_LENGTH);
}

function cleanPromptText(text: string): string {
  const taskText = text.match(/<task>\s*([\s\S]*?)\s*<\/task>/i)?.[1] ?? text;

  return taskText
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
    .replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, ' ')
    .replace(/<file(?:\s[^>]*)?>[\s\S]*?<\/file>/gi, ' ')
    .replace(/<file_content(?:\s[^>]*)?>[\s\S]*?<\/file_content>/gi, ' ')
    .replace(/<read_file>[\s\S]*?<\/read_file>/gi, ' ')
    .replace(/<search_files>[\s\S]*?<\/search_files>/gi, ' ')
    .replace(/^\[[^\]]+\]\s+Result:\s*/i, ' ')
    .replace(/\[ERROR\][\s\S]*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textFromValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(textFromValue).filter(Boolean).join('\n');
  }

  if (!isRecord(value)) {
    return '';
  }

  if (typeof value.type === 'string' && REDUNDANT_CONTENT_TYPES.has(value.type)) {
    return '';
  }

  if (typeof value.text === 'string') {
    return value.text;
  }

  if (typeof value.content === 'string') {
    return value.content;
  }

  return textFromValue(value.content);
}

function hasTools(tools: unknown[] | undefined) {
  return Array.isArray(tools) && tools.length > 0;
}

function providerHints(source: ProviderHintSource) {
  return {
    provider: toJsonValue(source.provider),
    providerOptions: toJsonValue(source.providerOptions),
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }

  if (!isRecord(value)) {
    return null;
  }

  const result: { [key: string]: JsonValue } = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? REDACTED_VALUE : toJsonValue(nestedValue);
  }

  return result;
}

function isSensitiveKey(key: string) {
  const normalizedKey = key.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some(pattern => normalizedKey.includes(pattern));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
