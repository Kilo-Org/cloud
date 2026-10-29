import * as z from 'zod';
import type { JsonValue, NormalizedClassifierInput } from './input';

// Reduces a full gateway request body to the compact classifier input. Lives
// in the shared contracts package so the Next.js gateway can normalize before
// mirroring (the full body averages hundreds of kilobytes; the normalized
// input is ~2KB) while the worker keeps using the same shapes.

const TEXT_PREFIX_MAX_LENGTH = 1000;
const REDACTED_VALUE = '[REDACTED]';
const TRUNCATED_VALUE = '[TRUNCATED]';
const TRUNCATED_KEY = '[truncated]';
// Provider hints are client-supplied JSON of unbounded size; cap how much
// work the redacting copy does so a pathological payload cannot turn the
// snapshot into an O(body) walk on the gateway request path. The budget is
// consumed per visited node and per object property, and traversal stops
// (with a truncation sentinel) the moment it runs out.
const PROVIDER_HINTS_MAX_NODES = 512;
// Message content, and the Responses input, are client-supplied JSON of
// unbounded depth: no schema below `content: z.unknown()` constrains their
// shape. Every walk this module does over them stays inside a fixed amount of
// work on the synchronous request path, the way the provider-hint copy does. A
// walk that reaches its limit keeps what it gathered and answers with the
// documented null or partial result.
//
// The node and length budgets cover the text walk, which runs per message and
// stops as soon as it has the prefix. The two body-wide walks (modalities and
// the token estimate) run over the whole body, which the request size already
// bounds, so they are bounded by depth alone and keep reporting every message.
const PROMPT_WALK_MAX_NODES = 1024;
const PROMPT_WALK_MAX_DEPTH = 64;
// Cleaning runs before the stored prefix is taken and is linear in the text it
// receives, so text is gathered up to this window and no further. The window has
// to be larger than any single block the cleaning passes strip, because a block
// whose closer falls outside it is kept as ordinary text: real agent prompts
// carry environment_details and file blocks of hundreds of kilobytes, and 1 MiB
// covers them while still bounding one message's cleaning to a few tens of
// milliseconds.
const PROMPT_TEXT_MAX_LENGTH = TEXT_PREFIX_MAX_LENGTH * 1024;
// Credential keys are matched on token boundaries: key names split at
// separators, digits, and camelCase humps into tokens, and a credential token
// matches exactly, so ordinary words that merely contain those letters stay
// intact. A credential word joined to a credential qualifier without any
// boundary counts as a credential key.
const SENSITIVE_KEY_WORDS = [
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'key',
  'password',
  'passwd',
  'secret',
  'token',
];
const SENSITIVE_KEY_QUALIFIERS = [
  'access',
  'account',
  'api',
  'app',
  'auth',
  'client',
  'encryption',
  'master',
  'private',
  'public',
  'root',
  'secret',
  'service',
  'session',
  'signing',
  'subscription',
];
// A qualifier only counts when it ends immediately before a credential word, so
// the scan before each occurrence never needs more than the longest qualifier.
const MAX_QUALIFIER_LENGTH = Math.max(...SENSITIVE_KEY_QUALIFIERS.map(q => q.length));
const REDUNDANT_CONTENT_TYPES = new Set([
  'function_call_output',
  'tool_call_output',
  'tool_result',
]);

export type ClassifierApiKind = NormalizedClassifierInput['apiKind'];

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

type Message = z.infer<typeof messageSchema>;
type ProviderHintSource = {
  provider?: unknown;
  providerOptions?: unknown;
};
type CommonBody = {
  model: string;
  stream?: boolean | undefined;
  provider?: unknown;
  providerOptions?: unknown;
  tools?: unknown[] | undefined;
};

// Values the caller captured before the body was mutated (the gateway
// rewrites `model` and provider fields in place during routing). When
// provided they are used verbatim and the body's own values are ignored.
type NormalizeOverrides = {
  requestedModel: string;
  providerHints: NormalizedClassifierInput['providerHints'];
};

export function normalizeClassifierInput(
  apiKind: ClassifierApiKind,
  body: unknown,
  overrides?: NormalizeOverrides
): NormalizedClassifierInput | null {
  if (apiKind === 'chat_completions') {
    const parsed = chatCompletionBodySchema.safeParse(body);
    if (!parsed.success) return null;

    const userPrompts = firstAndLatestPromptPrefix(parsed.data.messages, 'user');
    return {
      apiKind,
      systemPromptPrefix: firstPromptPrefix(parsed.data.messages, 'system'),
      userPromptPrefix: userPrompts.first,
      latestUserPromptPrefix: userPrompts.latest,
      messageCount: parsed.data.messages.length,
      ...commonFields(parsed.data, overrides),
    };
  }

  if (apiKind === 'responses') {
    const parsed = responsesBodySchema.safeParse(body);
    if (!parsed.success) return null;

    const inputMessages = inputToMessages(parsed.data.input);
    const userPrompts = firstAndLatestPromptPrefix(inputMessages, 'user');
    return {
      apiKind,
      systemPromptPrefix:
        textPrefix(parsed.data.instructions) ?? firstPromptPrefix(inputMessages, 'system'),
      userPromptPrefix: userPrompts.first ?? textPrefix(parsed.data.input),
      latestUserPromptPrefix: userPrompts.latest,
      messageCount: messageCount(parsed.data.input),
      ...commonFields(parsed.data, overrides),
    };
  }

  const parsed = messagesBodySchema.safeParse(body);
  if (!parsed.success) return null;

  const userPrompts = firstAndLatestPromptPrefix(parsed.data.messages, 'user');
  return {
    apiKind,
    systemPromptPrefix:
      textPrefix(parsed.data.system) ?? firstPromptPrefix(parsed.data.messages, 'system'),
    userPromptPrefix: userPrompts.first,
    latestUserPromptPrefix: userPrompts.latest,
    messageCount: parsed.data.messages.length,
    ...commonFields(parsed.data, overrides),
  };
}

function commonFields(data: CommonBody, overrides: NormalizeOverrides | undefined) {
  return {
    requestedModel: overrides?.requestedModel ?? data.model,
    hasTools: hasTools(data.tools),
    stream: data.stream === true,
    providerHints: overrides?.providerHints ?? redactProviderHints(data),
  };
}

// Snapshots provider hints into a redacted JSON value. Exported so the
// gateway can capture them before provider transforms mutate the body.
export function redactProviderHints(source: ProviderHintSource): {
  provider: JsonValue;
  providerOptions: JsonValue;
} {
  const budget = { remaining: PROVIDER_HINTS_MAX_NODES };
  return {
    provider: toJsonValue(source.provider, budget),
    providerOptions: toJsonValue(source.providerOptions, budget),
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

// Prefix extraction scans stop at the first usable message from each end:
// running the clean-text regexes over every message of a multi-hundred-turn
// agent conversation would dominate normalization cost for no extra signal.
function firstPromptPrefix(messages: Message[], role: string): string | null {
  for (const message of messages) {
    if (message.role !== role) continue;
    const prefix = textPrefix(message.content);
    if (prefix) return prefix;
  }
  return null;
}

function lastPromptPrefix(messages: Message[], role: string): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== role) continue;
    const prefix = textPrefix(message.content);
    if (prefix) return prefix;
  }
  return null;
}

function firstAndLatestPromptPrefix(
  messages: Message[],
  role: string
): { first: string | null; latest: string | null } {
  const first = firstPromptPrefix(messages, role);
  const latest = first === null ? null : lastPromptPrefix(messages, role);
  return { first, latest: latest && latest !== first ? latest : null };
}

function textPrefix(value: unknown): string | null {
  // Cleaning is linear in the text it receives, so the walk stops at the
  // window and only that much text reaches it.
  const text = cleanPromptText(textFromValue(value));

  if (text.length === 0) {
    return null;
  }

  return text.slice(0, TEXT_PREFIX_MAX_LENGTH);
}

// Message content is client-supplied and this runs synchronously on the
// gateway request path, so extraction walks the text with forward-only
// cursors: the opener search and the closer search cover ranges no earlier
// search covered, and the cost stays linear in the length of the text. A
// missing closing tag leaves the remaining text untouched and ends the pass.
type BlockPass = {
  // Opener scan. A literal opener includes the `>`; an attribute opener stops
  // at the tag name and is completed by the `>` search in `nextOpener`.
  open: RegExp;
  close: RegExp;
  attributes: boolean;
};

const BLOCK_PASSES: BlockPass[] = [
  { open: /<thinking>/gi, close: /<\/thinking>/gi, attributes: false },
  { open: /<environment_details>/gi, close: /<\/environment_details>/gi, attributes: false },
  { open: /<file/gi, close: /<\/file>/gi, attributes: true },
  { open: /<file_content/gi, close: /<\/file_content>/gi, attributes: true },
  { open: /<read_file>/gi, close: /<\/read_file>/gi, attributes: false },
  { open: /<search_files>/gi, close: /<\/search_files>/gi, attributes: false },
];

const TASK_OPEN = /<task>/i;
const TASK_CLOSE = /<\/task>/gi;
// Same character set as `\s`, and as the set `String.prototype.trim` strips.
const WHITESPACE = /\s/;

type OpenerMatch = { start: number; end: number };

// Next opener at or after `from`, or null when none can match. An attribute
// opener is the tag name, then `>`, or one whitespace character and the next
// `>` anywhere after it.
function nextOpener(pass: BlockPass, text: string, from: number): OpenerMatch | null {
  pass.open.lastIndex = from;
  for (;;) {
    const open = pass.open.exec(text);
    if (!open) return null;

    const end = open.index + open[0].length;
    if (!pass.attributes) return { start: open.index, end };

    const following = text[end];
    if (following === '>') return { start: open.index, end: end + 1 };
    if (following !== undefined && WHITESPACE.test(following)) {
      const bracket = text.indexOf('>', end + 1);
      // No `>` left in the text: this opener fails, so every later one does.
      return bracket < 0 ? null : { start: open.index, end: bracket + 1 };
    }

    pass.open.lastIndex = end;
  }
}

// Replaces every `open ... close` block with a single space: left to right,
// non-overlapping, nearest closer. A block whose closer is missing, and the
// text before the first opener, are kept as they are.
function stripBlocks(text: string, pass: BlockPass): string {
  let stripped = '';
  let cursor = 0;
  for (;;) {
    const open = nextOpener(pass, text, cursor);
    if (!open) break;

    pass.close.lastIndex = open.end;
    const close = pass.close.exec(text);
    if (!close) break;

    stripped += text.slice(cursor, open.start) + ' ';
    cursor = close.index + close[0].length;
  }

  return stripped + text.slice(cursor);
}

function extractTaskText(text: string): string {
  const open = TASK_OPEN.exec(text);
  if (!open) return text;

  TASK_CLOSE.lastIndex = open.index + open[0].length;
  const close = TASK_CLOSE.exec(text);
  if (!close) return text;

  return text.slice(open.index + open[0].length, close.index).trim();
}

function cleanPromptText(text: string): string {
  let cleaned = extractTaskText(text);
  for (const pass of BLOCK_PASSES) {
    cleaned = stripBlocks(cleaned, pass);
  }

  return cleaned
    .replace(/^\[[^\]]+\]\s+Result:\s*/i, ' ')
    .replace(/\[ERROR\][\s\S]*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Explicit-stack walk over a client-supplied content value: an array
// contributes the non-empty text of its children joined by `\n`, an object
// contributes `text`, then a string `content`, then the text of its own
// `content`, and a redundant tool-result part contributes nothing. The walk
// keeps its own stack because a content value can nest arbitrarily deep; the
// node and depth budgets end it, and the length budget stops it at the window
// the cleaning passes receive.
type TextWalkFrame =
  // `children` is how many child values were pushed, in document order.
  { kind: 'join'; children: number } | { kind: 'value'; value: unknown; depth: number };

function textFromValue(value: unknown): string {
  const work: TextWalkFrame[] = [{ kind: 'value', value, depth: 0 }];
  // Text of the completed frames; a frame pops what its children pushed.
  const results: string[] = [];
  let remainingNodes = PROMPT_WALK_MAX_NODES;
  let remainingChars = PROMPT_TEXT_MAX_LENGTH;

  // Keeps at most the remaining window of one text value.
  const keep = (text: string) => {
    const kept = text.slice(0, remainingChars);
    remainingChars -= kept.length;
    results.push(kept);
  };

  for (let frame = work.pop(); frame; frame = work.pop()) {
    if (frame.kind === 'join') {
      const parts: string[] = [];
      // Results were pushed in document order, so pop back-to-front.
      for (let index = 0; index < frame.children; index++) {
        parts.push(results.pop() ?? '');
      }
      results.push(parts.filter(Boolean).reverse().join('\n'));
      continue;
    }

    if (remainingNodes <= 0 || frame.depth > PROMPT_WALK_MAX_DEPTH) {
      results.push('');
      continue;
    }
    remainingNodes -= 1;

    const node = frame.value;

    if (typeof node === 'string') {
      keep(node);
      continue;
    }

    if (Array.isArray(node)) {
      // Push children back-to-front so they are visited in document order, and
      // only as many as the node budget still allows.
      const pushed = Math.min(node.length, remainingNodes);
      if (pushed === 0) {
        results.push('');
        continue;
      }
      work.push({ kind: 'join', children: pushed });
      for (let index = pushed - 1; index >= 0; index--) {
        work.push({ kind: 'value', value: node[index], depth: frame.depth + 1 });
      }
      continue;
    }

    if (!isRecord(node)) {
      results.push('');
      continue;
    }

    if (typeof node.type === 'string' && REDUNDANT_CONTENT_TYPES.has(node.type)) {
      results.push('');
      continue;
    }

    if (typeof node.text === 'string') {
      keep(node.text);
      continue;
    }

    if (typeof node.content === 'string') {
      keep(node.content);
      continue;
    }

    work.push({ kind: 'value', value: node.content, depth: frame.depth + 1 });
  }

  return results.pop() ?? '';
}

function hasTools(tools: unknown[] | undefined) {
  return Array.isArray(tools) && tools.length > 0;
}

function toJsonValue(value: unknown, budget: { remaining: number }): JsonValue {
  if (budget.remaining <= 0) {
    return TRUNCATED_VALUE;
  }
  budget.remaining -= 1;

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
    const result: JsonValue[] = [];
    for (const item of value) {
      if (budget.remaining <= 0) {
        result.push(TRUNCATED_VALUE);
        break;
      }
      result.push(toJsonValue(item, budget));
    }
    return result;
  }

  if (!isRecord(value)) {
    return null;
  }

  const result: { [key: string]: JsonValue } = {};
  // for-in (not Object.entries) so a huge object does not materialize every
  // entry up front; the loop breaks as soon as the budget runs out.
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (budget.remaining <= 0) {
      result[TRUNCATED_KEY] = TRUNCATED_VALUE;
      break;
    }
    budget.remaining -= 1;
    result[key] = isSensitiveKey(key) ? REDACTED_VALUE : toJsonValue(value[key], budget);
  }

  return result;
}

function isSensitiveKey(key: string) {
  return splitKeyTokens(key).some(isSensitiveToken);
}

function splitKeyTokens(key: string) {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(token => token.length > 0);
}

function isSensitiveToken(token: string) {
  const singular = token.endsWith('s') ? token.slice(0, -1) : token;
  if (SENSITIVE_KEY_WORDS.some(word => word === token || word === singular)) return true;
  for (const word of SENSITIVE_KEY_WORDS) {
    for (let index = token.indexOf(word); index !== -1; index = token.indexOf(word, index + 1)) {
      // A token that starts with a credential word is a credential key.
      if (index === 0) return true;
      // A qualifier counts only when it ends immediately before the occurrence,
      // so the last MAX_QUALIFIER_LENGTH characters are the whole window that
      // can match one.
      const window = token.slice(Math.max(0, index - MAX_QUALIFIER_LENGTH), index);
      if (SENSITIVE_KEY_QUALIFIERS.some(qualifier => window.endsWith(qualifier))) return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---------- Capability-aware routing helpers ----------

// Walks OpenAI chat completions, OpenAI Responses, and Anthropic Messages
// bodies looking for multimodal content parts. Returns the deduped, sorted
// set of capability tokens the request demands. This is independent of
// `normalizeClassifierInput` because (a) it inspects the raw gateway body
// before the request is mutated, and (b) it does not care about text —
// only which modalities a model must support. Malformed/unknown shapes
// are silently ignored; the caller treats an empty result as "text only".
export function detectRequiredInputModalities(body: unknown): string[] {
  const found = new Set<string>();
  collectModalities(body, found, 0);

  if (found.size === 0) {
    return [];
  }

  return [...found].sort();
}

// The same body reaches this walk as reaches the text walk, with the same
// unbounded nesting. Its work is already linear in the parsed body, which the
// request size bounds, and every level costs one node per message, so the
// walk is bounded by depth alone: a node count would stop it inside a long
// conversation and silently drop a modality from the newest turn. A value
// nested past the depth limit keeps what was found before it, which is the
// documented "malformed shapes are ignored" result.
function collectModalities(value: unknown, out: Set<string>, depth: number): void {
  if (value === null || value === undefined) return;
  if (depth > PROMPT_WALK_MAX_DEPTH) return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectModalities(item, out, depth + 1);
    }
    return;
  }

  if (!isRecord(value)) return;

  // Walk known container fields so message arrays and content parts are
  // visited. Bodies use different keys per provider:
  //   * OpenAI chat completions / Anthropic: `messages[]`
  //   * OpenAI Responses: `input` (string or array)
  // Content parts live under `content` (chat / Anthropic) or `parts`
  // (Responses). We do NOT recurse into every key — that would over-walk
  // tools, metadata, and provider hints — only into the known structural
  // containers.
  for (const key of MODALITY_CONTAINER_KEYS) {
    collectModalities(value[key], out, depth + 1);
  }

  // Typed content parts: OpenAI Responses `input_image` / `input_file`,
  // OpenAI chat `image_url`, Anthropic `image` / `document`.
  const type = value.type;
  if (typeof type === 'string') {
    if (type === 'image_url' || type === 'image' || type === 'input_image') {
      out.add('image');
    } else if (type === 'file' || type === 'input_file' || type === 'document') {
      out.add('file');
    }
  }

  // Guards against callers that omit the `type` discriminator — the
  // presence of a known media field is itself sufficient signal. We do NOT
  // treat a bare `file` key as a signal: it collides with ordinary tool
  // output (e.g. a `read_file` result whose `content` is `{ file: ... }`),
  // and the typed `file`/`input_file`/`document` cases above already cover
  // the real Responses/Anthropic file shapes.
  if ('image_url' in value || 'input_image' in value) {
    out.add('image');
  }
  if ('input_file' in value) {
    out.add('file');
  }
}

const MODALITY_CONTAINER_KEYS = ['messages', 'input', 'content', 'parts', 'system'];

// Routing-only token estimator. Deliberately distinct from the gateway's
// per-request `estimateTokenCount`, which mis-counts base64 image payloads
// as text. This estimator is a *capability gate* — its sole job is to
// produce a positive-integer hint that the worker can compare against
// model context limits. It must:
//   * include only textual content (plain `content` strings, `text` /
//     `input_text` part text, system strings, and tool-call payload
//     strings — which dominate agentic traffic),
//   * exclude media payload strings (image URLs, base64/data URLs,
//     file/document data) regardless of their length,
//   * add the body's output-token reservation when present,
//   * never return 0 when there is any text at all, and
//   * never return a fractional value (downstream schema is int).
export function estimateRoutingTokens(body: unknown): number {
  if (!isRecord(body)) return 0;

  const textChars = sumBodyTextChars(body, 0);
  const reservation = readOutputReservation(body);
  const raw = textChars / 4 + reservation;

  const rounded = Math.round(raw);
  if (rounded <= 0 && raw > 0) return 1;
  return rounded;
}

// Walks known container structures (messages, input, system, instructions)
// and extracts text from content parts. Does NOT recurse into arbitrary
// object fields — that would count `model`, `role`, tool definitions, etc.
// The nesting it follows is client-supplied, so it is bounded by depth like
// the modality walk: a node count would stop counting partway through a long
// conversation and under-report the context the request needs.
function sumBodyTextChars(body: Record<string, unknown>, depth: number): number {
  if (depth > PROMPT_WALK_MAX_DEPTH) return 0;

  let total = 0;

  // OpenAI chat completions / Anthropic messages: messages[]
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      total += sumMessageTextChars(msg, depth + 1);
    }
  }

  // Anthropic: top-level system field (string or parts array)
  const system = body.system;
  if (typeof system === 'string') {
    total += system.length;
  } else if (Array.isArray(system)) {
    for (const part of system) {
      total += sumContentPartTextChars(part, depth + 1);
    }
  }

  // Responses API: instructions (string) and input (string or array)
  if (typeof body.instructions === 'string') {
    total += body.instructions.length;
  }
  if ('input' in body) {
    total += sumResponsesInputChars(body.input, depth + 1);
  }

  return total;
}

function sumMessageTextChars(msg: unknown, depth: number): number {
  if (!isRecord(msg)) return 0;
  if (depth > PROMPT_WALK_MAX_DEPTH) return 0;

  let total = 0;

  // Content: string, parts array, or part object
  const content = msg.content;
  if (typeof content === 'string') {
    total += content.length;
  } else if (Array.isArray(content)) {
    for (const part of content) {
      total += sumContentPartTextChars(part, depth + 1);
    }
  } else if (isRecord(content)) {
    total += sumContentPartTextChars(content, depth + 1);
  }

  // OpenAI assistant tool_calls: count function.arguments strings
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (isRecord(tc) && isRecord(tc.function) && typeof tc.function.arguments === 'string') {
        total += tc.function.arguments.length;
      }
    }
  }

  return total;
}

function sumContentPartTextChars(part: unknown, depth: number): number {
  if (typeof part === 'string') return part.length;
  if (!isRecord(part)) return 0;
  if (depth > PROMPT_WALK_MAX_DEPTH) return 0;

  const type = part.type;

  // Media parts: zero contribution regardless of payload size
  if (typeof type === 'string') {
    if (
      type === 'image_url' ||
      type === 'image' ||
      type === 'input_image' ||
      type === 'file' ||
      type === 'input_file' ||
      type === 'document'
    ) {
      return 0;
    }

    // Text parts
    if (type === 'text' || type === 'input_text') {
      return typeof part.text === 'string' ? part.text.length : 0;
    }

    // Anthropic tool_use: count serialized input (can dominate agentic traffic)
    if (type === 'tool_use') {
      if (part.input !== undefined && part.input !== null) {
        return JSON.stringify(part.input).length;
      }
      return 0;
    }

    // Tool/function result content strings.
    // Anthropic/Chat Completions tool results use `content`; OpenAI Responses
    // `function_call_output` and `tool_call_output` items use `output`.
    if (type === 'tool_result' || type === 'function_call_output' || type === 'tool_call_output') {
      const text =
        type === 'function_call_output' || type === 'tool_call_output'
          ? (part.output ?? part.content)
          : part.content;
      if (typeof text === 'string') return text.length;
      if (Array.isArray(text)) {
        return text.reduce(
          (sum: number, p: unknown) => sum + sumContentPartTextChars(p, depth + 1),
          0
        );
      }
      return 0;
    }
  }

  // Untyped part: try to extract text from common fields
  if (typeof part.text === 'string') return part.text.length;
  if (typeof part.content === 'string') return part.content.length;
  if (Array.isArray(part.content)) {
    return part.content.reduce(
      (sum: number, p: unknown) => sum + sumContentPartTextChars(p, depth + 1),
      0
    );
  }

  return 0;
}

// Responses API input: string, array of messages/parts, or object
function sumResponsesInputChars(input: unknown, depth: number): number {
  if (typeof input === 'string') return input.length;
  if (depth > PROMPT_WALK_MAX_DEPTH) return 0;

  if (Array.isArray(input)) {
    let total = 0;
    for (const item of input) {
      if (typeof item === 'string') {
        total += item.length;
      } else if (isRecord(item)) {
        const type = item.type;
        // Responses API typed parts
        if (
          typeof type === 'string' &&
          (type === 'function_call_output' || type === 'tool_call_output')
        ) {
          total += sumContentPartTextChars(item, depth + 1);
        } else if (typeof type === 'string' && type === 'function_call') {
          // Responses API function_call: count arguments string
          if (typeof item.arguments === 'string') {
            total += item.arguments.length;
          }
        } else {
          // Message-like object with role and content
          total += sumMessageTextChars(item, depth + 1);
        }
      }
    }
    return total;
  }
  if (isRecord(input)) {
    // Single message-like object
    return sumMessageTextChars(input, depth + 1);
  }
  return 0;
}

function readOutputReservation(body: Record<string, unknown>): number {
  const candidates = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return 0;
}
