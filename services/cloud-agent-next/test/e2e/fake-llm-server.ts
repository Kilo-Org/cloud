/**
 * Fake LLM for cloud-agent E2E harness.
 *
 * Preferred path: local Next.js routes `fake-deterministic` here while
 * `KILO_OPENROUTER_BASE` stays on the real gateway. Masquerade routes
 * (`/api/openrouter/{models,models/validate,chat/completions}`) still work
 * if something points at this service directly.
 *
 * Directives in the last user message's content drive scenarios:
 *   `__fake__:<scenario>[:<arg1>[:<arg2>...]]`
 * No directive echoes the last user message (minus kilo wrappers).
 *
 * See `README.md` in this directory for the local harness protocol.
 *
 * See also `callback-server.ts` — same node:http + ephemeral-port lifecycle
 * handle pattern.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FakeLlmServerHandle = {
  /** Base URL without trailing slash, e.g. `http://0.0.0.0:18811`. */
  url: string;
  port: number;
  close: () => Promise<void>;
};

export type Directive = {
  scenario: string;
  args: string[];
};

type GateWaiter = {
  res: ServerResponse;
  req: IncomingMessage;
  model: string;
  release: () => void;
  cleanup: () => void;
};

type ToolKind = 'write' | 'read' | 'edit' | 'question';

type AdvertisedTool = {
  name: string;
  parameters: Record<string, unknown>;
};

type ToolResult = {
  id: string;
  content: string;
};

type ScenarioCounters = Record<ToolKind, number>;

export type FakeScenarioStatus = {
  tag: string;
  requests: number;
  toolCalls: ScenarioCounters;
  toolResults: ScenarioCounters;
  unsupportedToolSchema: boolean;
};

type InternalScenarioStatus = FakeScenarioStatus & {
  seenToolResults: Set<string>;
};

const RELEASED_GATE_FOLLOWUP_TTL_MS = 10_000;

type ServerState = {
  /**
   * Concurrent chat.completions calls can all share the same `gate:<tag>`
   * directive (kilo issues a small title-model call in addition to the
   * primary code call for a given user turn, and both see the same last
   * user message). We track every parked waiter and release them together.
   */
  gates: Map<string, GateWaiter[]>;
  /** One short-lived late same-tag request can drain after a single waiter release. */
  releasedGateFollowups: Map<string, number>;
  liveResponses: Set<ServerResponse>;
  /** Monotonic id for log correlation. Not visible to callers. */
  nextRequestId: number;
  /** Count of dispatched completions, exposed for fail-fast scenario assertions. */
  chatCompletionRequests: number;
  scenarios: Map<string, InternalScenarioStatus>;
};

type LogFields = Record<string, string | number | boolean | undefined>;

function logEvent(event: string, fields: LogFields): void {
  const parts: string[] = [`[fake-llm] ${event}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`);
  }
  console.log(parts.join(' '));
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a socket)
// ---------------------------------------------------------------------------

const DIRECTIVE_PREFIX = '__fake__:';

/**
 * Parse a `__fake__:<scenario>[:<arg1>[:<arg2>...]]` directive.
 *
 * The scenario name is the first `:`-delimited segment after the prefix; all
 * remaining text (including any further colons) becomes a single trailing
 * argument. This keeps `echo:hello:world` → `{ scenario: 'echo', args: ['hello:world'] }`
 * so scenario payloads are free to contain colons. Scenarios that take a
 * fixed number of numeric args (e.g. `slow:<n>:<ms>`) split their trailing
 * arg themselves if needed — the harness callers (`slow`) split on `:` and
 * take the first N.
 *
 * Returns null for missing prefix.
 */
export function parseDirective(text: string): Directive | null {
  const idx = text.indexOf(DIRECTIVE_PREFIX);
  if (idx < 0) return null;
  const remainder = text.slice(idx + DIRECTIVE_PREFIX.length);

  // Scenario names are simple harness identifiers. Stop at the first non-token
  // character so Kilo's appended `<environment_details>` block does not become
  // part of bare directives such as `__fake__:idle`.
  const scenario = remainder.match(/^([A-Za-z0-9_-]*)/)?.[1] ?? '';
  const rest = remainder.slice(scenario.length);
  if (!rest.startsWith(':')) {
    return { scenario, args: [] };
  }
  const args = rest.slice(1);
  return { scenario, args: args.length > 0 ? [args] : [''] };
}

type MessagePart = { type?: string; text?: string };
type Message = {
  role?: string;
  content?: string | MessagePart[];
  tool_call_id?: string;
};

/**
 * Extract the text of the last user message in an OpenAI-shape request body.
 *
 * `messages[-1].content` may be a plain string or an array of parts
 * `[{ type: 'text', text: '...' }, ...]`. Concatenates all text parts.
 *
 * Returns '' if there's no user message or no extractable text — which will
 * echo an empty completion.
 */
export function extractLastUserMessageText(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Message;
    if (msg?.role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(part => part?.type === 'text' || part?.type === undefined)
        .map(part => part.text ?? '')
        .join('');
    }
    return '';
  }
  return '';
}

/**
 * Drop kilo's appended `<environment_details>` block so a default echo does
 * not write system context back into the assistant transcript.
 */
export function stripKiloPromptWrapping(text: string): string {
  return text.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, '').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripPromptContext(value: string): string {
  const contextIndex = value.indexOf('<environment_details>');
  return (contextIndex < 0 ? value : value.slice(0, contextIndex)).trimEnd();
}

function directiveTag(directive: Directive | null): string | undefined {
  if (
    directive === null ||
    !['gate', 'write-then-gate', 'read-edit-then-gate', 'question'].includes(directive.scenario)
  ) {
    return undefined;
  }
  return directive.args[0]?.match(/^([A-Za-z0-9_-]+)/)?.[1];
}

function createCounters(): ScenarioCounters {
  return { write: 0, read: 0, edit: 0, question: 0 };
}

function scenarioStatus(state: ServerState, tag: string): InternalScenarioStatus {
  const existing = state.scenarios.get(tag);
  if (existing) return existing;
  const created: InternalScenarioStatus = {
    tag,
    requests: 0,
    toolCalls: createCounters(),
    toolResults: createCounters(),
    unsupportedToolSchema: false,
    seenToolResults: new Set(),
  };
  state.scenarios.set(tag, created);
  return created;
}

function advertisedTools(body: unknown): AdvertisedTool[] {
  if (!isRecord(body) || !Array.isArray(body.tools)) return [];
  const tools: AdvertisedTool[] = [];
  for (const entry of body.tools) {
    if (!isRecord(entry) || !isRecord(entry.function)) continue;
    const { name, parameters } = entry.function;
    if (typeof name !== 'string' || !isRecord(parameters)) continue;
    tools.push({ name, parameters });
  }
  return tools;
}

function toolCallId(tag: string, kind: ToolKind): string {
  const fingerprint = createHash('sha256').update(tag).digest('hex').slice(0, 12);
  return `call_${fingerprint}_${kind}`;
}

function toolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .map(part => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

function toolResults(body: unknown, tag: string, state: ServerState): ToolResult[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) return [];
  const result: ToolResult[] = [];
  const status = scenarioStatus(state, tag);
  for (const message of body.messages) {
    if (!isRecord(message) || message.role !== 'tool') continue;
    const id = message.tool_call_id;
    if (typeof id !== 'string') continue;
    const kind = (['write', 'read', 'edit', 'question'] as const).find(
      candidate => id === toolCallId(tag, candidate)
    );
    if (!kind) continue;
    if (!status.seenToolResults.has(id)) {
      status.seenToolResults.add(id);
      status.toolResults[kind] += 1;
    }
    result.push({ id, content: toolResultContent(message.content) });
  }
  return result;
}

function toolProperties(tool: AdvertisedTool): Record<string, unknown> | null {
  return isRecord(tool.parameters.properties) ? tool.parameters.properties : null;
}

function propertyName(properties: Record<string, unknown>, candidates: string[]): string | null {
  return candidates.find(candidate => candidate in properties) ?? null;
}

function supportsRequiredArguments(
  tool: AdvertisedTool,
  argumentsByName: Record<string, unknown>
): boolean {
  if (!Array.isArray(tool.parameters.required)) return true;
  return tool.parameters.required.every(
    required => typeof required === 'string' && required in argumentsByName
  );
}

function resolveTool(
  tools: AdvertisedTool[],
  kind: ToolKind,
  input: { path?: string; contents?: string; replacement?: string; question?: string }
): { tool: AdvertisedTool; arguments: Record<string, unknown> } | null {
  const names: Record<ToolKind, string[]> = {
    write: ['write', 'write_file', 'write_to_file'],
    read: ['read', 'read_file'],
    edit: ['edit', 'edit_file', 'search_and_replace', 'replace'],
    question: ['question', 'ask_followup_question', 'ask_follow_up_question'],
  };
  const tool = tools.find(candidate => names[kind].includes(candidate.name));
  if (!tool) return null;
  const properties = toolProperties(tool);
  if (!properties) return null;

  const args: Record<string, unknown> = {};
  if (kind === 'question') {
    if ('questions' in properties && input.question !== undefined) {
      args.questions = [
        {
          question: input.question,
          header: 'E2E',
          options: [{ label: 'Continue', description: 'Continue the E2E scenario' }],
        },
      ];
    } else if ('question' in properties && input.question !== undefined) {
      args.question = input.question;
      if ('options' in properties) {
        args.options = [{ label: 'Continue', description: 'Continue the E2E scenario' }];
      }
    } else {
      return null;
    }
    return supportsRequiredArguments(tool, args) ? { tool, arguments: args } : null;
  }

  const pathProperty = propertyName(properties, ['filePath', 'file_path', 'path', 'filename']);
  if (!pathProperty || input.path === undefined) return null;
  args[pathProperty] = input.path;

  if (kind === 'write') {
    const contentProperty = propertyName(properties, ['content', 'contents', 'text']);
    if (!contentProperty || input.contents === undefined) return null;
    args[contentProperty] = input.contents;
  }

  if (kind === 'edit') {
    const previousProperty = propertyName(properties, [
      'oldString',
      'old_string',
      'oldText',
      'old_text',
      'search',
      'old',
    ]);
    const replacementProperty = propertyName(properties, [
      'newString',
      'new_string',
      'newText',
      'new_text',
      'replace',
      'replacement',
      'new',
    ]);
    if (
      !previousProperty ||
      !replacementProperty ||
      input.contents === undefined ||
      input.replacement === undefined
    ) {
      return null;
    }
    args[previousProperty] = input.contents;
    args[replacementProperty] = input.replacement;
  }

  return supportsRequiredArguments(tool, args) ? { tool, arguments: args } : null;
}

function readFileContents(result: string): string {
  let content = result;
  try {
    const parsed: unknown = JSON.parse(result);
    if (isRecord(parsed) && typeof parsed.output === 'string') content = parsed.output;
  } catch {
    content = result;
  }
  const enclosed = content.match(/<(?:content|file)>\s*\n?([\s\S]*?)\n?<\/(?:content|file)>/);
  if (enclosed?.[1] !== undefined) content = enclosed[1];
  return content
    .split(/\r?\n/)
    .filter(line => !/^\s*\((?:End of file|Showing lines)/.test(line))
    .map(line => line.replace(/^\s*\d+\s*[:|]\s?/, ''))
    .join('\n')
    .trimEnd();
}

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

/**
 * One model, shaped to satisfy kilo's `openRouterModelSchema`
 * (see `packages/kilo-gateway/src/api/models.ts` in the kilocode repo).
 *
 * Must include `supported_parameters: ['tools', ...]` — models lacking
 * `tools` are dropped by kilo's filter (models.ts:122).
 */
/**
 * Model id is bare (no provider prefix). kilo's model cache keys each model
 * under `s.providers[providerID].models[modelID]` using the raw `id` returned
 * here, and looks models up with the bare id after stripping the `kilo/`
 * provider prefix via `parseModel` (see opencode
 * `packages/opencode/src/provider/provider.ts:1775`). The driver addresses
 * this model as `kilo/fake-deterministic` (provider prefix + bare id).
 */
const FAKE_MODEL = {
  id: 'fake-deterministic',
  name: 'Fake Deterministic',
  description: 'Deterministic fake model for cloud-agent E2E harness.',
  context_length: 200000,
  max_completion_tokens: 8192,
  pricing: {
    prompt: '0',
    completion: '0',
  },
  architecture: {
    input_modalities: ['text'],
    output_modalities: ['text'],
    tokenizer: 'fake',
  },
  top_provider: { max_completion_tokens: 8192 },
  supported_parameters: ['tools', 'temperature'],
};

function modelsCatalogue(): { data: Array<typeof FAKE_MODEL> } {
  return { data: [FAKE_MODEL] };
}

// ---------------------------------------------------------------------------
// SSE framing helpers
// ---------------------------------------------------------------------------

type ToolCallDelta = {
  index: number;
  id?: string;
  type?: 'function';
  function: { name?: string; arguments: string };
};

type ChunkDelta = {
  role?: string;
  content?: string;
  tool_calls?: ToolCallDelta[];
};

type FinishReason = 'stop' | 'tool_calls';

type Chunk = {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: ChunkDelta;
    finish_reason: null | FinishReason;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

function ensureStreamHeaders(res: ServerResponse): void {
  if (res.headersSent) return;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // Disable Node's default socket timeout so `hang`/`gate` don't 5-minute
  // themselves off the air.
  res.socket?.setTimeout(0);
  res.flushHeaders();
}

function makeChunk(
  id: string,
  model: string,
  delta: ChunkDelta,
  finishReason: null | FinishReason = null
): Chunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
      },
    ],
  };
}

function writeChunk(res: ServerResponse, chunk: Chunk): void {
  ensureStreamHeaders(res);
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function writeDone(res: ServerResponse): void {
  res.write('data: [DONE]\n\n');
}

function writeFinish(
  res: ServerResponse,
  id: string,
  model: string,
  completionTokens: number,
  finishReason: FinishReason = 'stop'
): void {
  const finalChunk: Chunk = {
    ...makeChunk(id, model, {}, finishReason),
    usage: {
      prompt_tokens: 10,
      completion_tokens: completionTokens,
      total_tokens: 10 + completionTokens,
    },
  };
  writeChunk(res, finalChunk);
  writeDone(res);
}

function writeJsonError(res: ServerResponse, status: number, message: string, type: string): void {
  if (res.headersSent) {
    // Stream already started — best-effort: end it.
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: {
        message,
        code: status,
        type,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

export type ScenarioContext = {
  req: IncomingMessage;
  res: ServerResponse;
  id: string;
  model: string;
  state: ServerState;
  body: unknown;
  tools: AdvertisedTool[];
  /** Correlation id for log entries of this request. */
  reqLogId: number;
};

export type ScenarioHandler = (args: string[], ctx: ScenarioContext) => Promise<void> | void;

function emitEcho(ctx: ScenarioContext, text: string): void {
  writeChunk(ctx.res, makeChunk(ctx.id, ctx.model, { role: 'assistant', content: text }));
  writeFinish(ctx.res, ctx.id, ctx.model, text.length);
  ctx.res.end();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeAssistantResponse(ctx: ScenarioContext, content: string): void {
  writeChunk(ctx.res, makeChunk(ctx.id, ctx.model, { role: 'assistant', content }));
  writeFinish(ctx.res, ctx.id, ctx.model, content.length);
  ctx.res.end();
}

function parkGate(ctx: ScenarioContext, tag: string, completion: string): void {
  const releasedFollowupExpiresAt = ctx.state.releasedGateFollowups.get(tag);
  if (releasedFollowupExpiresAt !== undefined) {
    ctx.state.releasedGateFollowups.delete(tag);
    if (Date.now() <= releasedFollowupExpiresAt) {
      writeAssistantResponse(ctx, completion);
      logEvent('scenario.unparked', {
        reqId: ctx.reqLogId,
        scenario: 'gate',
        tag,
        reason: 'released-followup',
      });
      return;
    }
  }

  ensureStreamHeaders(ctx.res);
  ctx.state.liveResponses.add(ctx.res);
  let releasedByTest = false;

  const cleanup = (): void => {
    ctx.state.liveResponses.delete(ctx.res);
    const waiters = ctx.state.gates.get(tag);
    if (!waiters) return;
    const remaining = waiters.filter(waiter => waiter.res !== ctx.res);
    if (remaining.length === 0) {
      ctx.state.gates.delete(tag);
    } else {
      ctx.state.gates.set(tag, remaining);
    }
  };

  const release = (): void => {
    releasedByTest = true;
    cleanup();
    writeAssistantResponse(ctx, completion);
    logEvent('scenario.unparked', {
      reqId: ctx.reqLogId,
      scenario: 'gate',
      tag,
      reason: 'released',
    });
  };

  ctx.res.on('close', () => {
    cleanup();
    if (!releasedByTest) {
      logEvent('scenario.unparked', {
        reqId: ctx.reqLogId,
        scenario: 'gate',
        tag,
        reason: 'client-closed',
      });
    }
  });

  const waiters = ctx.state.gates.get(tag) ?? [];
  waiters.push({ res: ctx.res, req: ctx.req, model: ctx.model, release, cleanup });
  ctx.state.gates.set(tag, waiters);
  logEvent('scenario.parked', {
    reqId: ctx.reqLogId,
    scenario: 'gate',
    tag,
    waiterCount: waiters.length,
  });
}

function writeToolCall(
  ctx: ScenarioContext,
  tag: string,
  kind: ToolKind,
  resolved: { tool: AdvertisedTool; arguments: Record<string, unknown> }
): void {
  scenarioStatus(ctx.state, tag).toolCalls[kind] += 1;
  writeChunk(
    ctx.res,
    makeChunk(ctx.id, ctx.model, {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: toolCallId(tag, kind),
          type: 'function',
          function: { name: resolved.tool.name, arguments: '' },
        },
      ],
    })
  );
  writeChunk(
    ctx.res,
    makeChunk(ctx.id, ctx.model, {
      tool_calls: [{ index: 0, function: { arguments: JSON.stringify(resolved.arguments) } }],
    })
  );
  writeFinish(ctx.res, ctx.id, ctx.model, 1, 'tool_calls');
  ctx.res.end();
}

function writeUnsupportedToolSchema(ctx: ScenarioContext, tag: string, kind: ToolKind): void {
  scenarioStatus(ctx.state, tag).unsupportedToolSchema = true;
  writeJsonError(ctx.res, 422, `unsupported ${kind} tool schema`, 'unsupported_tool_schema');
  logEvent('scenario.unsupported', {
    reqId: ctx.reqLogId,
    tag,
    advertisedTools: ctx.tools.length,
  });
}

function runToolScenario(
  ctx: ScenarioContext,
  tag: string,
  kind: ToolKind,
  input: { path?: string; contents?: string; replacement?: string; question?: string }
): void {
  const resolved = resolveTool(ctx.tools, kind, input);
  if (!resolved) {
    writeUnsupportedToolSchema(ctx, tag, kind);
    return;
  }
  writeToolCall(ctx, tag, kind, resolved);
}

/**
 * Scenario registry. Each handler writes SSE chunks to `ctx.res` and is
 * responsible for closing the response (or leaving it open for `hang`/`gate`).
 */
export const scenarioRegistry: Record<string, ScenarioHandler> = {
  echo(args, ctx) {
    // Harness `echo:<token>` only takes the first identifier so kilo's
    // appended `<environment_details>` cannot leak into the transcript.
    const rawArg = args[0] ?? '';
    const text = rawArg.match(/^([A-Za-z0-9_-]*)/)?.[1] ?? '';
    emitEcho(ctx, text);
  },

  async slow(args, ctx) {
    const raw = args[0] ?? '';
    const parts = raw.split(':');
    const n = Math.max(1, Number.parseInt(parts[0] ?? '1', 10) || 1);
    const delayMs = Math.max(0, Number.parseInt(parts[1] ?? '0', 10) || 0);
    const payload = 'slow-response';
    writeChunk(ctx.res, makeChunk(ctx.id, ctx.model, { role: 'assistant', content: '' }));
    let totalContent = 0;
    for (let i = 0; i < n; i++) {
      const piece = payload.slice(
        Math.floor((i * payload.length) / n),
        Math.floor(((i + 1) * payload.length) / n)
      );
      totalContent += piece.length;
      writeChunk(ctx.res, makeChunk(ctx.id, ctx.model, { content: piece }));
      if (i < n - 1 && delayMs > 0) await sleep(delayMs);
    }
    writeFinish(ctx.res, ctx.id, ctx.model, totalContent);
    ctx.res.end();
  },

  idle(_args, ctx) {
    writeChunk(ctx.res, makeChunk(ctx.id, ctx.model, {}));
    writeFinish(ctx.res, ctx.id, ctx.model, 0);
    ctx.res.end();
  },

  hang(_args, ctx) {
    ensureStreamHeaders(ctx.res);
    ctx.state.liveResponses.add(ctx.res);
    logEvent('scenario.parked', { reqId: ctx.reqLogId, scenario: 'hang' });
    // Never close. `close()` on the server handle will destroy the socket.
    ctx.res.on('close', () => {
      ctx.state.liveResponses.delete(ctx.res);
      logEvent('scenario.unparked', {
        reqId: ctx.reqLogId,
        scenario: 'hang',
        reason: 'client-closed',
      });
    });
  },

  error(args, ctx) {
    const message = args[0] ?? 'simulated error';
    writeJsonError(ctx.res, 402, message, 'insufficient_quota');
  },

  gate(args, ctx) {
    const match = stripPromptContext(args[0] ?? '').match(
      /^([A-Za-z0-9_-]+)(?::([A-Za-z0-9_-]+))?/
    );
    const tag = match?.[1];
    if (!tag) {
      writeJsonError(ctx.res, 402, 'gate directive requires a tag', 'invalid_request');
      return;
    }
    parkGate(ctx, tag, match[2] ?? 'done');
  },

  'write-then-gate'(args, ctx) {
    const parsed = stripPromptContext(args[0] ?? '').match(/^([A-Za-z0-9_-]+):([^:]+):([\s\S]+)$/);
    if (!parsed?.[1] || !parsed[2] || parsed[3] === undefined) {
      writeJsonError(
        ctx.res,
        402,
        'write-then-gate directive requires tag, path, and contents',
        'invalid_request'
      );
      return;
    }
    const [, tag, path, contents] = parsed;
    if (ctx.tools.length === 0) {
      writeAssistantResponse(ctx, `done-${tag}`);
      return;
    }
    const results = toolResults(ctx.body, tag, ctx.state);
    if (!results.some(result => result.id === toolCallId(tag, 'write'))) {
      runToolScenario(ctx, tag, 'write', { path, contents });
      return;
    }
    parkGate(ctx, tag, `done-${tag}`);
  },

  'read-edit-then-gate'(args, ctx) {
    const parsed = stripPromptContext(args[0] ?? '').match(/^([A-Za-z0-9_-]+):([^:]+):([\s\S]+)$/);
    if (!parsed?.[1] || !parsed[2] || parsed[3] === undefined) {
      writeJsonError(
        ctx.res,
        402,
        'read-edit-then-gate directive requires tag, path, and replacement',
        'invalid_request'
      );
      return;
    }
    const [, tag, path, replacement] = parsed;
    if (ctx.tools.length === 0) {
      writeAssistantResponse(ctx, `done-${tag}`);
      return;
    }
    const results = toolResults(ctx.body, tag, ctx.state);
    const readResult = results.find(result => result.id === toolCallId(tag, 'read'));
    if (!readResult) {
      runToolScenario(ctx, tag, 'read', { path });
      return;
    }
    if (!results.some(result => result.id === toolCallId(tag, 'edit'))) {
      const contents = readFileContents(readResult.content);
      if (!contents) {
        writeJsonError(
          ctx.res,
          422,
          'read tool returned no editable file contents',
          'invalid_tool_result'
        );
        return;
      }
      runToolScenario(ctx, tag, 'edit', { path, contents, replacement });
      return;
    }
    parkGate(ctx, tag, `done-${tag}`);
  },

  question(args, ctx) {
    const parsed = stripPromptContext(args[0] ?? '').match(/^([A-Za-z0-9_-]+):([\s\S]+)$/);
    if (!parsed?.[1] || !parsed[2]) {
      writeJsonError(
        ctx.res,
        402,
        'question directive requires a tag and question text',
        'invalid_request'
      );
      return;
    }
    const [, tag, question] = parsed;
    if (ctx.tools.length === 0) {
      writeAssistantResponse(ctx, `done-${tag}`);
      return;
    }
    const results = toolResults(ctx.body, tag, ctx.state);
    if (!results.some(result => result.id === toolCallId(tag, 'question'))) {
      runToolScenario(ctx, tag, 'question', { question });
      return;
    }
    writeAssistantResponse(ctx, `done-${tag}`);
  },
};

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function randomId(): string {
  return `chatcmpl-fake-${Math.random().toString(36).slice(2, 12)}`;
}

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  state: ServerState
): Promise<void> {
  state.chatCompletionRequests += 1;
  const reqLogId = ++state.nextRequestId;
  const startedAt = Date.now();

  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    writeJsonError(res, 400, 'invalid JSON body', 'invalid_request');
    logEvent('request.end', {
      reqId: reqLogId,
      status: 400,
      reason: 'invalid-json',
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  const messages = isRecord(body) ? body.messages : undefined;
  const messageCount = Array.isArray(messages) ? messages.length : 0;
  const bodyModel = isRecord(body) && typeof body.model === 'string' ? body.model : undefined;
  const prompt = extractLastUserMessageText(body);
  const directive = parseDirective(prompt);
  const tools = advertisedTools(body);
  const tag = directiveTag(directive);
  if (tag) scenarioStatus(state, tag).requests += 1;

  logEvent('request.start', {
    reqId: reqLogId,
    route: 'POST /api/openrouter/chat/completions',
    model: bodyModel,
    messages: messageCount,
    scenario: directive?.scenario ?? 'echo',
    args: directive === null ? '(default)' : undefined,
    tag,
    tools: tools.length,
  });

  const ctx: ScenarioContext = {
    req,
    res,
    id: randomId(),
    model: FAKE_MODEL.id,
    state,
    body,
    tools,
    reqLogId,
  };

  let finalized = false;
  const finalize = (status: number, reason: string): void => {
    if (finalized) return;
    finalized = true;
    logEvent('request.end', {
      reqId: reqLogId,
      status,
      reason,
      durationMs: Date.now() - startedAt,
    });
  };
  res.on('finish', () => finalize(res.statusCode || 200, 'finished'));
  res.on('close', () => {
    if (res.writableEnded) return;
    finalize(res.statusCode || 0, 'connection-closed');
  });

  if (directive === null) {
    emitEcho(ctx, stripKiloPromptWrapping(prompt));
    return;
  }

  const handler = scenarioRegistry[directive.scenario];
  if (!handler) {
    writeJsonError(res, 402, `unknown fake scenario: ${directive.scenario}`, 'invalid_request');
    return;
  }

  try {
    await handler(directive.args, ctx);
  } catch (err) {
    console.error('fake-llm scenario error:', err);
    if (!res.headersSent) {
      writeJsonError(res, 500, `scenario ${directive.scenario} threw`, 'server_error');
    } else {
      res.end();
    }
  }
}

function handleRelease(req: IncomingMessage, res: ServerResponse, state: ServerState): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const tag = url.searchParams.get('tag');
  if (!tag) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'tag query param required' }));
    return;
  }
  const waiters = state.gates.get(tag);
  if (!waiters || waiters.length === 0) {
    logEvent('release.miss', { tag });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `no waiter for tag: ${tag}` }));
    return;
  }
  const count = waiters.length;
  state.releasedGateFollowups.delete(tag);
  if (count === 1) {
    state.releasedGateFollowups.set(tag, Date.now() + RELEASED_GATE_FOLLOWUP_TTL_MS);
  }
  // Release every parked waiter for the tag (typically 2: kilo issues a
  // title call in addition to the primary code call for a user turn).
  // Copy first because release() mutates `state.gates` via cleanup.
  for (const waiter of [...waiters]) {
    waiter.release();
  }
  logEvent('release.ok', { tag, released: count });
  res.writeHead(204);
  res.end();
}

/**
 * Report whether a `gate:<tag>` scenario is currently parked waiting for
 * release. The driver polls this endpoint to know that kilo has actually
 * dialed the fake LLM and the turn is blocked — a precondition for queue
 * scenarios that need the first turn to stay busy.
 */
function handleGateStatus(req: IncomingMessage, res: ServerResponse, state: ServerState): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const tag = url.searchParams.get('tag');
  if (!tag) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'tag query param required' }));
    return;
  }
  const engaged = state.gates.has(tag);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ tag, engaged }));
}

function handleModels(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(modelsCatalogue()));
}

async function handleModelValidation(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    writeJsonError(res, 400, 'invalid JSON body', 'invalid_request');
    return;
  }

  if (typeof body !== 'object' || body === null || !('modelId' in body)) {
    writeJsonError(res, 400, 'modelId is required', 'invalid_request');
    return;
  }
  if (typeof body.modelId !== 'string') {
    writeJsonError(res, 400, 'modelId is required', 'invalid_request');
    return;
  }

  const valid = body.modelId === FAKE_MODEL.id;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(valid ? { valid: true } : { valid: false, reason: 'unavailable' }));
}

function handleRequestCounts(res: ServerResponse, state: ServerState): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ chatCompletions: state.chatCompletionRequests }));
}

function handleScenarioStatus(req: IncomingMessage, res: ServerResponse, state: ServerState): void {
  const tag = new URL(req.url ?? '/', 'http://localhost').searchParams.get('tag');
  if (!tag || !/^[A-Za-z0-9_-]+$/.test(tag)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'valid tag query param required' }));
    return;
  }
  const status = scenarioStatus(state, tag);
  const response: FakeScenarioStatus = {
    tag,
    requests: status.requests,
    toolCalls: status.toolCalls,
    toolResults: status.toolResults,
    unsupportedToolSchema: status.unsupportedToolSchema,
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

/**
 * Snapshot of all currently parked gate waiters, grouped by tag. Tests use
 * this after expected completions to assert the fake server has no stale
 * waiters (e.g., a title-model call that was never released).
 */
function handleWaiters(res: ServerResponse, state: ServerState): void {
  const tags: Array<{ tag: string; count: number }> = [];
  for (const [tag, waiters] of state.gates.entries()) {
    tags.push({ tag, count: waiters.length });
  }
  const totalHangs = state.liveResponses.size;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ tags, liveResponses: totalHangs }));
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export async function startFakeLlmServer(opts?: {
  host?: string;
  port?: number;
}): Promise<FakeLlmServerHandle> {
  const host = opts?.host ?? '0.0.0.0';
  const requestedPort = opts?.port ?? 0;
  const state: ServerState = {
    gates: new Map(),
    releasedGateFollowups: new Map(),
    liveResponses: new Set(),
    nextRequestId: 0,
    chatCompletionRequests: 0,
    scenarios: new Map(),
  };

  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method ?? 'GET'} ${url.pathname}`;

    if (route === 'GET /api/openrouter/models') {
      handleModels(res);
      return;
    }
    if (
      route === 'POST /api/openrouter/models/validate' ||
      (req.method === 'POST' &&
        /^\/api\/organizations\/[^/]+\/models\/validate$/.test(url.pathname))
    ) {
      handleModelValidation(req, res).catch(err => {
        console.error('fake-llm models/validate error:', err);
        if (!res.headersSent) {
          writeJsonError(res, 500, 'internal error', 'server_error');
        } else {
          res.end();
        }
      });
      return;
    }
    if (route === 'POST /api/openrouter/chat/completions') {
      handleChatCompletions(req, res, state).catch(err => {
        console.error('fake-llm chat/completions error:', err);
        if (!res.headersSent) {
          writeJsonError(res, 500, 'internal error', 'server_error');
        } else {
          res.end();
        }
      });
      return;
    }
    if (route === 'POST /test/release') {
      handleRelease(req, res, state);
      return;
    }
    if (route === 'GET /test/gate-status') {
      handleGateStatus(req, res, state);
      return;
    }
    if (route === 'GET /test/waiters') {
      handleWaiters(res, state);
      return;
    }
    if (route === 'GET /test/requests') {
      handleRequestCounts(res, state);
      return;
    }
    if (route === 'GET /test/scenario-status') {
      handleScenarioStatus(req, res, state);
      return;
    }

    logEvent('request.unknown', { method: req.method, path: url.pathname });
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `not found: ${route}` }));
  });

  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://${host}:${port}`;

  async function close(): Promise<void> {
    // Release any pending gates so they don't hold the process open.
    for (const waiters of state.gates.values()) {
      for (const waiter of waiters) {
        waiter.cleanup();
        if (!waiter.res.writableEnded) waiter.res.end();
      }
    }
    state.gates.clear();
    state.releasedGateFollowups.clear();
    state.scenarios.clear();
    // End any in-flight hang responses.
    for (const res of state.liveResponses) {
      if (!res.writableEnded) res.end();
    }
    state.liveResponses.clear();
    // Force-destroy open sockets so server.close() can resolve promptly.
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  return { url, port, close };
}

// ---------------------------------------------------------------------------
// CLI entry — `tsx fake-llm-server.ts` started by the dev service launcher.
// ---------------------------------------------------------------------------

const isMain = (() => {
  // import.meta.url → file:// path; process.argv[1] → executed script path
  try {
    const argvPath = process.argv[1];
    if (!argvPath) return false;
    const scriptUrl = new URL(`file://${argvPath}`).href;
    return scriptUrl === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  const port = Number.parseInt(process.env.PORT ?? '8811', 10);
  startFakeLlmServer({ port, host: '0.0.0.0' })
    .then(handle => {
      console.log(`[fake-llm] listening on ${handle.url}`);
      const shutdown = async (signal: string): Promise<void> => {
        console.log(`[fake-llm] received ${signal}, shutting down`);
        await handle.close();
        process.exit(0);
      };
      process.on('SIGINT', () => {
        void shutdown('SIGINT');
      });
      process.on('SIGTERM', () => {
        void shutdown('SIGTERM');
      });
    })
    .catch(err => {
      console.error('[fake-llm] failed to start:', err);
      process.exit(1);
    });
}
