/**
 * Fake LLM deterministic core, runtime-neutral.
 *
 * Shared by the local Node `http` adapter (`fake-llm-server.ts`) and the
 * Cloudflare Worker + Durable Object adapter (`fake-llm-worker.ts`). The core
 * never touches a socket: it reads a `FakeLlmRequest` and writes through a
 * `FakeLlmEmit`, so both runtimes execute exactly the same semantics.
 *
 * Directives in the last user message's content drive scenarios:
 *   `__fake__:<scenario>[:<arg1>[:<arg2>...]]`
 * No directive echoes the last user message (minus kilo wrappers).
 *
 * See `README.md` in the e2e directory for the local harness protocol.
 */

import { createHash } from 'node:crypto';

import { isAdminAuthorized } from './fake-llm-admin.js';

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

/** Runtime-neutral view of one inbound request. `url` is path + query. */
export type FakeLlmRequest = {
  method: string;
  url: string;
  /** Lowercased header names. */
  headers: Readonly<Record<string, string | undefined>>;
  readText(): Promise<string>;
};

/**
 * Runtime-neutral response sink.
 *
 * `start`/`sse`/`done` drive the SSE path, `json`/`empty` the non-streamed
 * path. `empty` must produce a bodyless response: `POST /test/release`
 * answers 204 and callers assert the absence of a body.
 */
export type FakeLlmEmit = {
  /** SSE headers (idempotent). */
  start(): void;
  /** `start()` then `data: <json>\n\n`. */
  sse(chunk: unknown): void;
  /** `data: [DONE]\n\n`. */
  done(): void;
  /** JSON body; if the stream already started, just end it. */
  json(status: number, body: unknown): void;
  /** Bodyless response. Never a JSON body. */
  empty(status: number): void;
  /** Adapter-defined: pre-shape -> 500; post-shape -> terminate the stream. */
  fail(error: unknown): void;
  end(): void;
  isStarted(): boolean;
  onClose(listener: () => void): void;
};

export type Directive = {
  scenario: string;
  args: string[];
};

/**
 * Parsed `file:` directive. One grammar, three ops:
 *
 *   file:write:<opTag>:<path>:<contents>       literal contents; real write call
 *   file:seed:<opTag>:<path>:<bytes>:<nonce>   fake-generated fixture; real write call
 *   file:read:<opTag>:<path>                   real read call; echo the parsed result
 *
 * `opTag` is `[A-Za-z0-9_-]+` and is the attribution key: `directiveTag` returns
 * it, never the op. The scenario mints a fresh `opTag` per turn, so a reused
 * tag can never match a previous turn's `tool_call_id` (a hash of the tag).
 *
 * Accepted contract: `write` contents are literal and may contain newlines; the
 * single-line rule applies only to the header fields (`opTag`/`path`/`bytes`/
 * `nonce`). Only the appended `<environment_details>` prompt block is stripped.
 */
export type FileDirective =
  | { op: 'write'; opTag: string; path: string; contents: string }
  | { op: 'seed'; opTag: string; path: string; bytes: number; nonce: string }
  | { op: 'read'; opTag: string; path: string };

export type FileDirectiveParse =
  | { ok: true; directive: FileDirective }
  | { ok: false; message: string };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

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
  /**
   * True once a `file:` turn for this opTag accepted a tool result and echoed.
   * A completed opTag is single-use: a later request reusing it is rejected, so
   * a reused tag cannot return the previous turn's result.
   */
  fileCompleted: boolean;
};

export type GateWaiter = {
  emit: FakeLlmEmit;
  model: string;
  release(): void;
  cleanup(): void;
};

export type FakeLlmState = {
  /**
   * Concurrent chat.completions calls can all share the same `gate:<tag>`
   * directive (kilo issues a small title-model call in addition to the
   * primary code call for a given user turn, and both see the same last
   * user message). We track every parked waiter and release them together,
   * so the value is an array per tag.
   *
   * Transient: waiters cannot survive an eviction, so this is never persisted.
   */
  gates: Map<string, GateWaiter[]>;
  /** Durable: one short-lived late same-tag request may drain after a release. */
  releasedGateFollowups: Map<string, number>;
  /** Transient: open streams (gate waiters and `hang`) for teardown. */
  liveResponses: Set<FakeLlmEmit>;
  /** Monotonic id for log correlation. Not visible to callers. */
  nextRequestId: number;
  /** Count of dispatched completions, exposed for fail-fast scenario assertions. */
  chatCompletionRequests: number;
  /** Count of dispatched audio/transcriptions calls, exposed for fail-fast scenario assertions. */
  transcriptionRequests: number;
  /** Durable: per-tag scenario counters. */
  scenarios: Map<string, InternalScenarioStatus>;
};

const RELEASED_GATE_FOLLOWUP_TTL_MS = 10_000;

/** Bound on scenarios retained in the persisted snapshot, in insertion (FIFO) order. */
export const MAX_PERSISTED_SCENARIOS = 200;
/** Tags longer than this are dropped from the persisted snapshot. */
export const MAX_PERSISTED_TAG_LENGTH = 256;

/** Durable Object storage key for the serialized snapshot. */
export const FAKE_LLM_STATE_STORAGE_KEY = 'fake-llm-state-v1';

export const HEALTH_BODY = { status: 'ok', service: 'fake-llm' } as const;

export type PersistedScenarioStatus = {
  tag: string;
  requests: number;
  toolCalls: ScenarioCounters;
  toolResults: ScenarioCounters;
  unsupportedToolSchema: boolean;
  seenToolResults: string[];
  /** Optional for snapshots written before file opTags became single-use. */
  fileCompleted?: boolean;
};

/**
 * Serialized shape of the durable half of the state. `gates` and
 * `liveResponses` are transient and never appear here.
 */
export type PersistedFakeLlmState = {
  nextRequestId: number;
  chatCompletionRequests: number;
  transcriptionRequests: number;
  releasedGateFollowups: Array<[string, number]>;
  scenarios: PersistedScenarioStatus[];
};

export function createFakeLlmState(): FakeLlmState {
  return {
    gates: new Map(),
    releasedGateFollowups: new Map(),
    liveResponses: new Set(),
    nextRequestId: 0,
    chatCompletionRequests: 0,
    transcriptionRequests: 0,
    scenarios: new Map(),
  };
}

/**
 * Persist only the durable half, bounded:
 *
 * - expired `releasedGateFollowups` entries are dropped;
 * - scenarios keep the newest `MAX_PERSISTED_SCENARIOS` in Map insertion order
 *   (FIFO eviction: the oldest are evicted first, in insertion order);
 * - tags longer than `MAX_PERSISTED_TAG_LENGTH` are skipped.
 *
 * The local Node runtime never evicts: this bound applies to the snapshot only.
 */
export function serializeFakeLlmState(state: FakeLlmState): PersistedFakeLlmState {
  const now = Date.now();
  const releasedGateFollowups: Array<[string, number]> = [];
  for (const [tag, expiresAt] of state.releasedGateFollowups) {
    if (expiresAt > now) releasedGateFollowups.push([tag, expiresAt]);
  }

  const scenarios: PersistedScenarioStatus[] = [];
  for (const status of state.scenarios.values()) {
    if (status.tag.length > MAX_PERSISTED_TAG_LENGTH) continue;
    scenarios.push({
      tag: status.tag,
      requests: status.requests,
      toolCalls: { ...status.toolCalls },
      toolResults: { ...status.toolResults },
      unsupportedToolSchema: status.unsupportedToolSchema,
      seenToolResults: [...status.seenToolResults],
      fileCompleted: status.fileCompleted,
    });
  }
  // FIFO: drop the oldest entries first, keeping the newest in insertion order.
  const retained = scenarios.slice(Math.max(0, scenarios.length - MAX_PERSISTED_SCENARIOS));

  return {
    nextRequestId: state.nextRequestId,
    chatCompletionRequests: state.chatCompletionRequests,
    transcriptionRequests: state.transcriptionRequests,
    releasedGateFollowups,
    scenarios: retained,
  };
}

/** Rebuild transient maps empty and restore the persisted counters and scenarios. */
export function hydrateFakeLlmState(
  persisted: PersistedFakeLlmState | undefined | null
): FakeLlmState {
  const state = createFakeLlmState();
  if (!persisted) return state;

  state.nextRequestId = persisted.nextRequestId ?? 0;
  state.chatCompletionRequests = persisted.chatCompletionRequests ?? 0;
  state.transcriptionRequests = persisted.transcriptionRequests ?? 0;
  for (const [tag, expiresAt] of persisted.releasedGateFollowups ?? []) {
    state.releasedGateFollowups.set(tag, expiresAt);
  }
  for (const scenario of persisted.scenarios ?? []) {
    state.scenarios.set(scenario.tag, {
      tag: scenario.tag,
      requests: scenario.requests ?? 0,
      toolCalls: { ...createCounters(), ...scenario.toolCalls },
      toolResults: { ...createCounters(), ...scenario.toolResults },
      unsupportedToolSchema: scenario.unsupportedToolSchema === true,
      seenToolResults: new Set(scenario.seenToolResults ?? []),
      fileCompleted: scenario.fileCompleted === true,
    });
  }
  return state;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

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
 * fixed number of numeric args (e.g. `slow:<n>:<ms>:<bytes>`) split their trailing
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

const FILE_TAG = '[A-Za-z0-9_-]+';

/**
 * Upper bound for a `file:seed` fixture; mirrors `MAX_TOOL_STREAM_BYTES`.
 */
export const MAX_FILE_SEED_BYTES = 1024 * 1024;
/** Upper bound for the `file:seed` nonce line (the only variable-length prefix). */
export const MAX_FILE_SEED_NONCE_LENGTH = 64;

/**
 * Strip only the prompt-context block Kilo appends after the directive, so a
 * literal write body keeps its own newlines. The CLI may separate the block
 * from the payload with blank lines, so the newline run directly before the
 * marker is dropped with it.
 */
function stripAppendedPromptContext(raw: string): string {
  const contextIndex = raw.indexOf('<environment_details>');
  if (contextIndex < 0) return raw;
  return raw.slice(0, contextIndex).replace(/\n+$/, '');
}

/** Header-only fields (`read`/`seed`) are a single line; `write` keeps its body. */
function firstDirectiveLine(value: string): string {
  const lineEnd = value.search(/\r?\n/);
  return lineEnd < 0 ? value : value.slice(0, lineEnd);
}

/**
 * The single parser for `file:` directives, used by both the handler and
 * `directiveTag` (it normalizes internally).
 *
 * Explicit colon grammar: the path is the field immediately after the opTag and
 * must not contain `:` or a newline. For `read`/`seed` any extra `:` therefore
 * fails the anchored match and is rejected, and the directive header is a single
 * line. For `write` the path is the first colon-free field and everything after
 * it is literal contents, newlines included, so a colon or newline in the input
 * after the path is content, not a path (asserted by the unit tests). Unknown
 * op, missing args, a colon path or an out-of-range seed size is a parse failure
 * the handler reports as 402 `invalid_request`.
 */
export function parseFileDirective(raw: string): FileDirectiveParse {
  const input = stripAppendedPromptContext(raw);

  const write = input.match(new RegExp(`^write:(${FILE_TAG}):([^:\\r\\n]+):([\\s\\S]*)$`));
  if (write) {
    return {
      ok: true,
      directive: { op: 'write', opTag: write[1], path: write[2], contents: write[3] },
    };
  }

  const header = firstDirectiveLine(input);
  const seed = header.match(
    new RegExp(`^seed:(${FILE_TAG}):([^:]+):(\\d+):([A-Za-z0-9_-]+)$`)
  );
  if (seed) {
    const nonce = seed[4];
    if (nonce.length > MAX_FILE_SEED_NONCE_LENGTH) {
      return {
        ok: false,
        message: `file:seed nonce ${nonce.length} exceeds maximum ${MAX_FILE_SEED_NONCE_LENGTH}`,
      };
    }
    const bytes = Number.parseInt(seed[3], 10);
    if (!Number.isSafeInteger(bytes) || bytes > MAX_FILE_SEED_BYTES) {
      return { ok: false, message: `file:seed byte count ${seed[3]} is out of range` };
    }
    if (bytes < nonce.length + 1) {
      return {
        ok: false,
        message: `file:seed byte count ${bytes} is smaller than the ${nonce.length + 1}-byte nonce prefix`,
      };
    }
    return {
      ok: true,
      directive: { op: 'seed', opTag: seed[1], path: seed[2], bytes, nonce },
    };
  }

  const read = header.match(new RegExp(`^read:(${FILE_TAG}):([^:]+)$`));
  if (read) {
    return { ok: true, directive: { op: 'read', opTag: read[1], path: read[2] } };
  }

  return {
    ok: false,
    message: 'file directive requires write|seed|read with a tag and a colon-free path',
  };
}

/**
 * A conservative tool-error check for normalized tool output. A nonempty error
 * must never pass as file contents. Recognizes an `is_error: true` JSON marker
 * and the `Error`/`error:`/`failed` prefixes the read tool uses on failure,
 * anchored at the start of any line so path metadata on an earlier line does
 * not hide a raw error line.
 */
export function isToolError(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) && parsed.is_error === true) return true;
  } catch {
    // Not JSON; fall through to the line-prefix check.
  }
  return trimmed.split('\n').some(line => /^(?:error\b|error:|failed\b)/i.test(line.trim()));
}

/**
 * A tool result normalized through one envelope unwrap. `envelopePath` is the
 * outer JSON envelope's declared path; `output` is the tool output with at most
 * one `output` field unwrapped; `error` is set by the envelope's `is_error`
 * marker or by an error prefix on the final output.
 */
export type NormalizedToolResult = {
  output: string;
  envelopePath: string | null;
  error: boolean;
};

export type ToolResultNormalization =
  | { ok: true; result: NormalizedToolResult }
  | { ok: false; message: string };

function isToolResultEnvelope(value: unknown): value is Record<string, unknown> & { output: string } {
  return isRecord(value) && typeof value.output === 'string';
}

/** True when `output` is itself a JSON `output` envelope (a second unwrap). */
function hasNestedOutputEnvelope(output: string): boolean {
  try {
    return isToolResultEnvelope(JSON.parse(output.trim()));
  } catch {
    return false;
  }
}

/**
 * The single owner of tool-result envelope normalization. It unwraps one JSON
 * `output` field while preserving the envelope's `is_error` and path metadata,
 * rejects a doubly nested envelope (which would need a second, unsupported
 * unwrap and could smuggle an error past the check), and runs the error check on
 * the final normalized output before the caller accepts it.
 */
export function normalizeToolResult(raw: string): ToolResultNormalization {
  let output = raw;
  let envelopePath: string | null = null;
  let error = false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      if (parsed.is_error === true) error = true;
      if (typeof parsed.path === 'string') envelopePath = parsed.path;
      else if (typeof parsed.filePath === 'string') envelopePath = parsed.filePath;
      if (typeof parsed.output === 'string') {
        if (hasNestedOutputEnvelope(parsed.output)) {
          return { ok: false, message: 'nested tool-result envelope is not supported' };
        }
        output = parsed.output;
      }
    }
  } catch {
    // Not JSON; the raw string is the output.
  }
  if (isToolError(output)) error = true;
  return { ok: true, result: { output, envelopePath, error } };
}

export type ReadResultPath =
  | { ok: true; path: string | null }
  | { ok: false; message: string };

/**
 * The read tool's reported path: an envelope field or a `<path>` element in the
 * unwrapped output. The two sources must agree; a conflicting pair is rejected
 * rather than silently preferring one, so a result can never be relabelled.
 */
function readResultPath(normalized: NormalizedToolResult): ReadResultPath {
  const inner = normalized.output.match(/<path>\s*([^<]+?)\s*<\/path>/)?.[1] ?? null;
  if (normalized.envelopePath !== null && inner !== null && normalized.envelopePath !== inner) {
    return { ok: false, message: 'conflicting read result path metadata' };
  }
  return { ok: true, path: normalized.envelopePath ?? inner };
}

/**
 * Path contract for a `file:read` result (lead decision).
 *
 * The requested path is used **verbatim** in the emitted read tool call, relative
 * or absolute; the fake cannot know the checkout's absolute path, so it does not
 * try to resolve one. The result path is accepted when it equals the requested
 * path exactly, or when the result path is absolute and ends with
 * `/<requested path>` for a **relative** request. A relative request may
 * therefore match a same-basename result in another directory (the reader's
 * runtime resolves the relative path against its own working directory, which is
 * what the harness is proving); an absolute request must match exactly, so a
 * same-basename file elsewhere is rejected.
 *
 * The shared-checkout proof does not rest on path exactness: it rests on the
 * writer's nonce, which is absent from the reader's path and opTag, so only a
 * genuine read of the writer's file can produce the parsed echo body. This
 * matcher only binds the echo to the requested file name.
 */
function readResultMatchesRequest(resultPath: string | null, requestedPath: string): boolean {
  if (resultPath === null) return false;
  const strip = (value: string) => value.replace(/^\.\//, '').replace(/\/+$/, '');
  const requested = strip(requestedPath.trim());
  const result = strip(resultPath.trim());
  if (requested === '' || result === '') return false;
  if (result === requested) return true;
  return !requested.startsWith('/') && result.startsWith('/') && result.endsWith(`/${requested}`);
}

/**
 * Deterministic `file:seed` payload: exactly `bytes` UTF-8 bytes, made of a
 * `nonce\n` prefix line followed by 99-character lines + `\n` (mirroring
 * `sandbox-control.ts`). Short lines keep the read tool's per-line handling from
 * truncating a single long line. The parser rejects sizes too small for the
 * prefix; this function throws if called directly with such a size.
 */
export function buildSeedFixture(bytes: number, nonce: string): string {
  const prefix = `${nonce}\n`;
  const remaining = bytes - prefix.length;
  if (remaining < 0) {
    throw new Error(
      `file:seed byte count ${bytes} is smaller than the ${prefix.length}-byte nonce prefix`
    );
  }
  const lineWidth = 99;
  const line = `${'x'.repeat(lineWidth)}\n`;
  const fullLines = Math.floor(remaining / (lineWidth + 1));
  const remainder = remaining - fullLines * (lineWidth + 1);
  return `${prefix}${line.repeat(fullLines)}${'x'.repeat(remainder)}`;
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

/**
 * Extract a top-level field's value from a `multipart/form-data` body.
 *
 * The harness must not gain a runtime dependency for one, so this does the
 * minimal boundary split the gateway proxy path needs: parts are separated by
 * `--<boundary>` lines, each part carries a `Content-Disposition` header whose
 * `name="<field>"` selects it, and the value is everything between the header
 * block and the next delimiter. Binary file parts survive as mangled utf8 —
 * irrelevant, since only text fields (currently `model`) are read.
 *
 * Returns the decoded value, or null when the field is absent.
 */
export function extractMultipartField(
  body: string,
  boundary: string,
  field: string
): string | null {
  const delimiter = `--${boundary}`;
  for (const part of body.split(delimiter)) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const disposition = part
      .slice(0, headerEnd)
      .split('\r\n')
      .find(line => /^content-disposition:/i.test(line));
    if (!disposition) continue;
    if (disposition.match(/name="([^"]*)"/)?.[1] !== field) continue;
    // Drop the `\r\n` that frames the value against the next delimiter.
    return part.slice(headerEnd + 4).replace(/\r\n$/, '');
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripPromptContext(value: string): string {
  const contextIndex = value.indexOf('<environment_details>');
  return (contextIndex < 0 ? value : value.slice(0, contextIndex)).trimEnd();
}

function directiveTag(directive: Directive | null): string | undefined {
  if (directive === null) return undefined;
  if (directive.scenario === 'file') {
    const parsed = parseFileDirective(directive.args[0] ?? '');
    return parsed.ok ? parsed.directive.opTag : undefined;
  }
  if (
    ![
      'gate',
      'write-then-gate',
      'read-edit-then-gate',
      'read-then-write',
      'tool-stream',
      'question',
    ].includes(directive.scenario)
  ) {
    return undefined;
  }
  return directive.args[0]?.match(/^([A-Za-z0-9_-]+)/)?.[1];
}

function createCounters(): ScenarioCounters {
  return { write: 0, read: 0, edit: 0, question: 0 };
}

function scenarioStatus(state: FakeLlmState, tag: string): InternalScenarioStatus {
  const existing = state.scenarios.get(tag);
  if (existing) return existing;
  const created: InternalScenarioStatus = {
    tag,
    requests: 0,
    toolCalls: createCounters(),
    toolResults: createCounters(),
    unsupportedToolSchema: false,
    seenToolResults: new Set(),
    fileCompleted: false,
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

export function toolCallId(tag: string, kind: ToolKind): string {
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

function toolResults(body: unknown, tag: string, state: FakeLlmState): ToolResult[] {
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

/**
 * Speech-to-text catalogue served for `GET /api/openrouter/models` with
 * `output_modalities=transcription`. Two ids: the happy path the mobile e2e
 * scenarios address, and a broken one whose transcription request 404s so the
 * non-retryable unhappy state is provable without an upstream key.
 */
const TRANSCRIPTION_MODELS = [
  {
    id: 'fake-transcribe',
    name: 'Fake Transcribe',
    context_length: 128000,
    pricing: { prompt: '0', completion: '0' },
  },
  {
    id: 'fake-transcribe-broken',
    name: 'Broken Transcriber',
    context_length: 128000,
    pricing: { prompt: '0', completion: '0' },
  },
];

// ---------------------------------------------------------------------------
// SSE chunk shaping
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
  reasoning?: string;
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

function writeChunk(emit: FakeLlmEmit, chunk: Chunk): void {
  emit.sse(chunk);
}

function writeFinish(
  emit: FakeLlmEmit,
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
  writeChunk(emit, finalChunk);
  emit.done();
}

function writeJsonError(emit: FakeLlmEmit, status: number, message: string, type: string): void {
  emit.json(status, {
    error: {
      message,
      code: status,
      type,
    },
  });
}

// ---------------------------------------------------------------------------
// Scenario registry
// ---------------------------------------------------------------------------

export type ScenarioContext = {
  emit: FakeLlmEmit;
  id: string;
  model: string;
  state: FakeLlmState;
  body: unknown;
  tools: AdvertisedTool[];
  /** Correlation id for log entries of this request. */
  reqLogId: number;
};

export type ScenarioHandler = (args: string[], ctx: ScenarioContext) => Promise<void> | void;

function emitEcho(ctx: ScenarioContext, text: string): void {
  writeChunk(ctx.emit, makeChunk(ctx.id, ctx.model, { role: 'assistant', content: text }));
  writeFinish(ctx.emit, ctx.id, ctx.model, text.length);
  ctx.emit.end();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const MAX_REALISTIC_CHARS = 4000;
export const MAX_REALISTIC_PIECES = 512;

/**
 * Upper bound for the `tool-stream:<tag>:<bytes>` request. The harness stages a
 * file of exactly `bytes` inside the worktree and the directive asks Kilo to
 * read `tool-stream-<tag>.txt`; the bytes therefore cross the Kilo -> wrapper ->
 * client direction as a tool RESULT. This caps the *request*, not the emitted
 * payload: a larger request is an invalid directive (HTTP 402) rather than a
 * silently smaller stream.
 */
export const MAX_TOOL_STREAM_BYTES = 1024 * 1024;

/**
 * Upper bound for the `slow:<n>:<ms>:<bytes>` per-chunk delay. Without it a
 * directive such as `slow:200:3600000` parks a Durable Object for hours after
 * the SSE stream is gone. Existing scenarios use at most 250 ms and the
 * documented example is 200 ms, so this keeps them intact with wide headroom
 * while bounding one call to `n * MAX_SLOW_DELAY_MS`.
 */
export const MAX_SLOW_DELAY_MS = 5_000;

export function buildRealisticReasoning(text: string): string[] {
  const fingerprint = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const reasoningSeed = `input=${fingerprint} chars=${text.length}`;
  return [
    `Analyzing ${reasoningSeed}.`,
    `Planning ${reasoningSeed}.`,
    `Preparing ${reasoningSeed}.`,
  ];
}

export function splitRealisticContent(text: string): string[] {
  const cappedText = text.slice(0, MAX_REALISTIC_CHARS);
  const splitPieces = cappedText.split(/(\s+)/).filter(piece => piece.length > 0);
  if (splitPieces.length <= MAX_REALISTIC_PIECES) return splitPieces;
  // Keep the full capped text while bounding the number of streamed chunks.
  return [
    ...splitPieces.slice(0, MAX_REALISTIC_PIECES - 1),
    splitPieces.slice(MAX_REALISTIC_PIECES - 1).join(''),
  ];
}

function writeAssistantResponse(ctx: ScenarioContext, content: string): void {
  writeChunk(ctx.emit, makeChunk(ctx.id, ctx.model, { role: 'assistant', content }));
  writeFinish(ctx.emit, ctx.id, ctx.model, content.length);
  ctx.emit.end();
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

  ctx.emit.start();
  ctx.state.liveResponses.add(ctx.emit);
  let releasedByTest = false;

  const cleanup = (): void => {
    ctx.state.liveResponses.delete(ctx.emit);
    const waiters = ctx.state.gates.get(tag);
    if (!waiters) return;
    const remaining = waiters.filter(waiter => waiter.emit !== ctx.emit);
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

  const waiters = ctx.state.gates.get(tag) ?? [];
  waiters.push({ emit: ctx.emit, model: ctx.model, release, cleanup });
  ctx.state.gates.set(tag, waiters);
  logEvent('scenario.parked', {
    reqId: ctx.reqLogId,
    scenario: 'gate',
    tag,
    waiterCount: waiters.length,
  });

  // Register the close listener only after the waiter is visible in `gates`:
  // an emit that is already closed (client aborted before the turn parked)
  // invokes `onClose` synchronously, so cleanup removes the waiter instead of
  // leaving a phantom entry that teardown can never reach.
  ctx.emit.onClose(() => {
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
}

function writeToolCall(
  ctx: ScenarioContext,
  tag: string,
  kind: ToolKind,
  resolved: { tool: AdvertisedTool; arguments: Record<string, unknown> }
): void {
  scenarioStatus(ctx.state, tag).toolCalls[kind] += 1;
  writeChunk(
    ctx.emit,
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
    ctx.emit,
    makeChunk(ctx.id, ctx.model, {
      tool_calls: [{ index: 0, function: { arguments: JSON.stringify(resolved.arguments) } }],
    })
  );
  writeFinish(ctx.emit, ctx.id, ctx.model, 1, 'tool_calls');
  ctx.emit.end();
}

function writeUnsupportedToolSchema(ctx: ScenarioContext, tag: string, kind: ToolKind): void {
  scenarioStatus(ctx.state, tag).unsupportedToolSchema = true;
  writeJsonError(ctx.emit, 422, `unsupported ${kind} tool schema`, 'unsupported_tool_schema');
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
 * Scenario registry. Each handler writes SSE chunks through `ctx.emit` and is
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

  async realistic(args, ctx) {
    const text = stripPromptContext(args[0] ?? '');
    const contentPieces = splitRealisticContent(text);
    const reasoningPieces = buildRealisticReasoning(text);

    writeChunk(ctx.emit, makeChunk(ctx.id, ctx.model, { role: 'assistant' }));
    for (const [index, reasoning] of reasoningPieces.entries()) {
      if (index > 0) await sleep(120);
      writeChunk(ctx.emit, makeChunk(ctx.id, ctx.model, { reasoning }));
    }
    for (const [index, piece] of contentPieces.entries()) {
      if (index > 0) await sleep(80);
      writeChunk(ctx.emit, makeChunk(ctx.id, ctx.model, { content: piece }));
    }
    writeFinish(ctx.emit, ctx.id, ctx.model, contentPieces.join('').length);
    ctx.emit.end();
  },

  async slow(args, ctx) {
    const raw = args[0] ?? '';
    const parts = raw.split(':');
    const n = Math.min(200, Math.max(1, Number.parseInt(parts[0] ?? '1', 10) || 1));
    const delayMs = Math.min(
      MAX_SLOW_DELAY_MS,
      Math.max(0, Number.parseInt(parts[1] ?? '0', 10) || 0)
    );
    const chunkBytes = Math.min(2048, Math.max(0, Number.parseInt(parts[2] ?? '0', 10) || 0));
    writeChunk(ctx.emit, makeChunk(ctx.id, ctx.model, { role: 'assistant', content: '' }));
    let closed = false;
    ctx.emit.onClose(() => {
      closed = true;
    });
    let totalContent = 0;
    for (let i = 0; i < n; i++) {
      if (closed) break;
      let piece: string;
      if (chunkBytes > 0) {
        const token = ` w${i} `;
        piece = token.repeat(Math.ceil(chunkBytes / token.length)).slice(0, chunkBytes);
      } else {
        const payload = 'slow-response';
        piece = payload.slice(
          Math.floor((i * payload.length) / n),
          Math.floor(((i + 1) * payload.length) / n)
        );
      }
      totalContent += piece.length;
      writeChunk(ctx.emit, makeChunk(ctx.id, ctx.model, { content: piece }));
      if (i < n - 1 && delayMs > 0) await sleep(delayMs);
    }
    writeFinish(ctx.emit, ctx.id, ctx.model, totalContent);
    ctx.emit.end();
  },

  idle(_args, ctx) {
    writeChunk(ctx.emit, makeChunk(ctx.id, ctx.model, {}));
    writeFinish(ctx.emit, ctx.id, ctx.model, 0);
    ctx.emit.end();
  },

  hang(_args, ctx) {
    ctx.emit.start();
    ctx.state.liveResponses.add(ctx.emit);
    logEvent('scenario.parked', { reqId: ctx.reqLogId, scenario: 'hang' });
    // Never close. The adapter tears down live responses on shutdown.
    ctx.emit.onClose(() => {
      ctx.state.liveResponses.delete(ctx.emit);
      logEvent('scenario.unparked', {
        reqId: ctx.reqLogId,
        scenario: 'hang',
        reason: 'client-closed',
      });
    });
  },

  'error-terminal'(args, ctx) {
    const message = args[0] ?? 'simulated error';
    writeJsonError(ctx.emit, 400, message, 'invalid_request');
  },

  error(args, ctx) {
    const message = args[0] ?? 'simulated error';
    writeJsonError(ctx.emit, 402, message, 'insufficient_quota');
  },

  gate(args, ctx) {
    const match = stripPromptContext(args[0] ?? '').match(
      /^([A-Za-z0-9_-]+)(?::([A-Za-z0-9_-]+))?/
    );
    const tag = match?.[1];
    if (!tag) {
      writeJsonError(ctx.emit, 402, 'gate directive requires a tag', 'invalid_request');
      return;
    }
    parkGate(ctx, tag, match[2] ?? 'done');
  },

  'write-then-gate'(args, ctx) {
    const parsed = stripPromptContext(args[0] ?? '').match(/^([A-Za-z0-9_-]+):([^:]+):([\s\S]+)$/);
    if (!parsed?.[1] || !parsed[2] || parsed[3] === undefined) {
      writeJsonError(
        ctx.emit,
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
        ctx.emit,
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
          ctx.emit,
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

  'read-then-write'(args, ctx) {
    const parsed = stripPromptContext(args[0] ?? '').match(
      /^([A-Za-z0-9_-]+):([^:]+):([^:]+):([\s\S]+)$/
    );
    if (!parsed?.[1] || !parsed[2] || !parsed[3] || parsed[4] === undefined) {
      writeJsonError(
        ctx.emit,
        402,
        'read-then-write directive requires tag, srcPath, destPath, and prefix',
        'invalid_request'
      );
      return;
    }
    const [, tag, srcPath, destPath, prefix] = parsed;
    if (ctx.tools.length === 0) {
      writeAssistantResponse(ctx, `done-${tag}`);
      return;
    }
    const results = toolResults(ctx.body, tag, ctx.state);
    const readResult = results.find(result => result.id === toolCallId(tag, 'read'));
    if (!readResult) {
      runToolScenario(ctx, tag, 'read', { path: srcPath });
      return;
    }
    if (!results.some(result => result.id === toolCallId(tag, 'write'))) {
      const contents = stripPromptContext(readFileContents(readResult.content));
      if (!contents) {
        writeJsonError(ctx.emit, 422, 'read tool returned no file contents', 'invalid_tool_result');
        return;
      }
      runToolScenario(ctx, tag, 'write', {
        path: destPath,
        contents: `${prefix}\n${contents}`,
      });
      return;
    }
    parkGate(ctx, tag, `done-${tag}`);
  },

  /**
   * `file:<op>:<opTag>:...` — one real tool turn per request, attributed to the
   * fresh per-turn `opTag`. `toolResults()` matches `(tag, kind)` across the
   * whole request history, so a reused tag could return a previous turn's
   * result; the fresh tag makes a historical `tool_call_id` unmatchable because
   * `toolCallId` hashes the tag. Only a result whose id equals
   * `toolCallId(opTag, kind)` satisfies the current turn, and only after this
   * tag emitted exactly one call for that kind.
   *
   * The read echo is the shared-checkout proof: the fake reads
   * `<result.content>` from the current request's `role:'tool'` message for the
   * fresh `opTag` only. It never sees the writer chat's content and keys no state
   * on the writer's tag. That result is produced by Kilo executing the real read
   * tool against the reading chat's runtime filesystem, so a parsed body proves
   * the reader's runtime saw the writer's uncommitted file; a missing/error read
   * fails closed with 422.
   */
  file(args, ctx) {
    // `parseFileDirective` normalizes internally, so this and `directiveTag`
    // parse identical input.
    const parsed = parseFileDirective(args[0] ?? '');
    if (!parsed.ok) {
      writeJsonError(ctx.emit, 402, parsed.message, 'invalid_request');
      return;
    }
    const directive = parsed.directive;
    if (ctx.tools.length === 0) {
      writeAssistantResponse(ctx, `done-${directive.opTag}`);
      return;
    }

    const kind: ToolKind = directive.op === 'read' ? 'read' : 'write';
    const status = scenarioStatus(ctx.state, directive.opTag);
    // Accepted contract: a replayed identical file-completion is answered 409
    // rather than idempotently. This is conservative fail-closed for the proof
    // harness: a fresh opTag is minted per turn, so a replay means the scenario
    // reused a tag and the previous result must not be re-served.
    if (status.fileCompleted) {
      writeJsonError(
        ctx.emit,
        409,
        `file opTag ${directive.opTag} already completed`,
        'invalid_request'
      );
      return;
    }
    const results = toolResults(ctx.body, directive.opTag, ctx.state);
    const result =
      status.toolCalls[kind] === 1
        ? results.find(candidate => candidate.id === toolCallId(directive.opTag, kind))
        : undefined;

    if (!result) {
      if (directive.op === 'read') {
        runToolScenario(ctx, directive.opTag, 'read', { path: directive.path });
      } else if (directive.op === 'seed') {
        runToolScenario(ctx, directive.opTag, 'write', {
          path: directive.path,
          contents: buildSeedFixture(directive.bytes, directive.nonce),
        });
      } else {
        runToolScenario(ctx, directive.opTag, 'write', {
          path: directive.path,
          contents: directive.contents,
        });
      }
      return;
    }

    if (directive.op !== 'read') {
      status.fileCompleted = true;
      writeAssistantResponse(ctx, `file-write:${directive.path}\n`);
      return;
    }

    const normalization = normalizeToolResult(toolResultContent(result.content));
    if (!normalization.ok) {
      writeJsonError(ctx.emit, 422, normalization.message, 'invalid_tool_result');
      return;
    }
    const normalized = normalization.result;
    const resultPath = readResultPath(normalized);
    if (
      !resultPath.ok ||
      normalized.error ||
      !readResultMatchesRequest(resultPath.path, directive.path)
    ) {
      writeJsonError(
        ctx.emit,
        422,
        'read tool did not return file contents for the requested path',
        'invalid_tool_result'
      );
      return;
    }
    const body = stripPromptContext(readFileContents(normalized.output));
    if (body === '') {
      writeJsonError(ctx.emit, 422, 'read tool did not return file contents', 'invalid_tool_result');
      return;
    }
    status.fileCompleted = true;
    writeAssistantResponse(ctx, `file-read:${directive.path}\n${body}`);
  },

  'tool-stream'(args, ctx) {
    const parsed = stripPromptContext(args[0] ?? '').match(/^([A-Za-z0-9_-]+):(\d+)$/);
    if (!parsed?.[1] || parsed[2] === undefined) {
      writeJsonError(
        ctx.emit,
        402,
        'tool-stream directive requires a tag and a byte count',
        'invalid_request'
      );
      return;
    }
    const [, tag, rawBytes] = parsed;
    const bytes = Number.parseInt(rawBytes, 10);
    if (bytes > MAX_TOOL_STREAM_BYTES) {
      writeJsonError(
        ctx.emit,
        402,
        `tool-stream byte request ${bytes} exceeds maximum ${MAX_TOOL_STREAM_BYTES}`,
        'invalid_request'
      );
      return;
    }
    if (ctx.tools.length === 0) {
      writeAssistantResponse(ctx, `done-${tag}`);
      return;
    }
    const path = `tool-stream-${tag}.txt`;
    const results = toolResults(ctx.body, tag, ctx.state);
    if (!results.some(result => result.id === toolCallId(tag, 'read'))) {
      // The harness stages exactly `bytes` at this path before the turn; ask
      // Kilo to read it so the payload crosses as a tool result. No huge tool
      // argument is ever emitted.
      runToolScenario(ctx, tag, 'read', { path });
      return;
    }
    writeAssistantResponse(ctx, `done-${tag}`);
  },

  question(args, ctx) {
    const parsed = stripPromptContext(args[0] ?? '').match(/^([A-Za-z0-9_-]+):([\s\S]+)$/);
    if (!parsed?.[1] || !parsed[2]) {
      writeJsonError(
        ctx.emit,
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

function randomId(): string {
  return `chatcmpl-fake-${Math.random().toString(36).slice(2, 12)}`;
}

async function handleChatCompletions(
  request: FakeLlmRequest,
  emit: FakeLlmEmit,
  state: FakeLlmState
): Promise<void> {
  state.chatCompletionRequests += 1;
  const reqLogId = ++state.nextRequestId;
  const startedAt = Date.now();

  const raw = await request.readText();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    writeJsonError(emit, 400, 'invalid JSON body', 'invalid_request');
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
    emit,
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
  emit.onClose(() => finalize(0, 'connection-closed'));

  if (directive === null) {
    emitEcho(ctx, stripKiloPromptWrapping(prompt));
    finalize(200, 'finished');
    return;
  }

  const handler = scenarioRegistry[directive.scenario];
  if (!handler) {
    writeJsonError(emit, 402, `unknown fake scenario: ${directive.scenario}`, 'invalid_request');
    finalize(402, 'unknown-scenario');
    return;
  }

  try {
    await handler(directive.args, ctx);
    finalize(200, 'finished');
  } catch (err) {
    console.error('fake-llm scenario error:', err);
    if (!emit.isStarted()) {
      writeJsonError(emit, 500, `scenario ${directive.scenario} threw`, 'server_error');
    } else {
      emit.end();
    }
    finalize(500, 'scenario-threw');
  }
}

/**
 * `POST /api/openrouter/audio/transcriptions` — the speech-to-text leg the
 * Kilo gateway proxy dials. Accepts the two shapes that reach it: a
 * `multipart/form-data` body (mobile proxy path) or the JSON
 * `{ model, input_audio: { data, format } }` the web proxy forwards.
 * `fake-transcribe-broken` 404s so scenarios can drive the non-retryable
 * unhappy state; every other model returns the fixed transcript.
 */
async function handleAudioTranscriptions(
  request: FakeLlmRequest,
  emit: FakeLlmEmit,
  state: FakeLlmState
): Promise<void> {
  state.transcriptionRequests += 1;
  const reqLogId = ++state.nextRequestId;
  const startedAt = Date.now();

  const contentType = request.headers['content-type'] ?? '';
  const multipart = contentType.startsWith('multipart/form-data');
  const raw = await request.readText();

  let model: string | null = null;
  let invalidBody: string | null = null;
  if (multipart) {
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/);
    const delimiter = boundary?.[1] ?? boundary?.[2];
    if (delimiter) {
      model = extractMultipartField(raw, delimiter, 'model');
    } else {
      invalidBody = 'multipart body is missing a boundary';
    }
  } else {
    try {
      const body: unknown = JSON.parse(raw);
      if (isRecord(body) && typeof body.model === 'string') model = body.model;
      else invalidBody = 'model field is required';
    } catch {
      invalidBody = 'invalid JSON body';
    }
  }

  logEvent('request.start', {
    reqId: reqLogId,
    route: 'POST /api/openrouter/audio/transcriptions',
    mode: multipart ? 'multipart' : 'json',
    model: model ?? undefined,
  });

  const fail = (status: number, message: string, type: string, reason: string): void => {
    writeJsonError(emit, status, message, type);
    logEvent('request.end', {
      reqId: reqLogId,
      status,
      reason,
      durationMs: Date.now() - startedAt,
    });
  };

  if (invalidBody) {
    fail(400, invalidBody, 'invalid_request', 'invalid-body');
    return;
  }
  if (model === null) {
    fail(400, 'model field is required', 'invalid_request', 'missing-model');
    return;
  }
  if (model === 'fake-transcribe-broken') {
    fail(404, `model not found: ${model}`, 'model_not_found', 'model-not-found');
    return;
  }

  emit.json(200, { text: 'Gateway transcription online' });
  logEvent('request.end', {
    reqId: reqLogId,
    status: 200,
    reason: 'finished',
    durationMs: Date.now() - startedAt,
  });
}

function handleRelease(request: FakeLlmRequest, emit: FakeLlmEmit, state: FakeLlmState): void {
  const url = new URL(request.url, 'http://fake');
  const tag = url.searchParams.get('tag');
  if (!tag) {
    emit.json(400, { error: 'tag query param required' });
    return;
  }
  const waiters = state.gates.get(tag);
  if (!waiters || waiters.length === 0) {
    logEvent('release.miss', { tag });
    emit.json(404, { error: `no waiter for tag: ${tag}` });
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
  emit.empty(204);
}

/**
 * Report whether a `gate:<tag>` scenario is currently parked waiting for
 * release. The driver polls this endpoint to know that kilo has actually
 * dialed the fake LLM and the turn is blocked — a precondition for queue
 * scenarios that need the first turn to stay busy.
 */
function handleGateStatus(request: FakeLlmRequest, emit: FakeLlmEmit, state: FakeLlmState): void {
  const url = new URL(request.url, 'http://fake');
  const tag = url.searchParams.get('tag');
  if (!tag) {
    emit.json(400, { error: 'tag query param required' });
    return;
  }
  const engaged = state.gates.has(tag);
  emit.json(200, { tag, engaged });
}

function handleModels(request: FakeLlmRequest, emit: FakeLlmEmit): void {
  const url = new URL(request.url, 'http://fake');
  if (url.searchParams.get('output_modalities') === 'transcription') {
    emit.json(200, { data: TRANSCRIPTION_MODELS });
    return;
  }
  emit.json(200, modelsCatalogue());
}

async function handleModelValidation(request: FakeLlmRequest, emit: FakeLlmEmit): Promise<void> {
  const raw = await request.readText();
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    writeJsonError(emit, 400, 'invalid JSON body', 'invalid_request');
    return;
  }

  if (typeof body !== 'object' || body === null || !('modelId' in body)) {
    writeJsonError(emit, 400, 'modelId is required', 'invalid_request');
    return;
  }
  if (typeof body.modelId !== 'string') {
    writeJsonError(emit, 400, 'modelId is required', 'invalid_request');
    return;
  }

  const valid = body.modelId === FAKE_MODEL.id;
  emit.json(200, valid ? { valid: true } : { valid: false, reason: 'unavailable' });
}

function handleRequestCounts(emit: FakeLlmEmit, state: FakeLlmState): void {
  emit.json(200, {
    chatCompletions: state.chatCompletionRequests,
    transcriptions: state.transcriptionRequests,
  });
}

function handleScenarioStatus(
  request: FakeLlmRequest,
  emit: FakeLlmEmit,
  state: FakeLlmState
): void {
  const tag = new URL(request.url, 'http://fake').searchParams.get('tag');
  if (!tag || !/^[A-Za-z0-9_-]+$/.test(tag)) {
    emit.json(400, { error: 'valid tag query param required' });
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
  emit.json(200, response);
}

/**
 * Snapshot of all currently parked gate waiters, grouped by tag. Tests use
 * this after expected completions to assert the fake server has no stale
 * waiters (e.g., a title-model call that was never released).
 */
function handleWaiters(emit: FakeLlmEmit, state: FakeLlmState): void {
  const tags: Array<{ tag: string; count: number }> = [];
  for (const [tag, waiters] of state.gates.entries()) {
    tags.push({ tag, count: waiters.length });
  }
  const totalHangs = state.liveResponses.size;
  emit.json(200, { tags, liveResponses: totalHangs });
}

const ORGANIZATION_MODELS_VALIDATE = /^\/api\/organizations\/[^/]+\/models\/validate$/;

export type FakeLlmRequestOptions = {
  /** Admin bearer required by every `/test/*` route. Missing/empty fails closed. */
  adminToken: string | undefined;
};

/**
 * Dispatch one request through the deterministic core.
 *
 * The `/test/*` guard runs on the path, before method dispatch, so every
 * `/test/*` request is authenticated identically in both runtimes — including
 * unsupported methods, which then fall through to 404 after failing auth.
 * Model routes are guarded by the Worker entry only (see `fake-llm-model-auth.ts`);
 * the local Node server deliberately keeps them open.
 */
export async function handleFakeLlmRequest(
  request: FakeLlmRequest,
  emit: FakeLlmEmit,
  state: FakeLlmState,
  options: FakeLlmRequestOptions
): Promise<void> {
  try {
    const pathname = new URL(request.url, 'http://fake').pathname;
    const route = `${request.method} ${pathname}`;

    if (route === 'GET /health') {
      emit.json(200, HEALTH_BODY);
      return;
    }

    if (pathname.startsWith('/test/')) {
      if (!isAdminAuthorized(request.headers.authorization, options.adminToken)) {
        emit.json(401, { error: 'admin authorization required' });
        return;
      }
    }

    if (route === 'GET /api/openrouter/models') {
      handleModels(request, emit);
      return;
    }
    if (
      route === 'POST /api/openrouter/models/validate' ||
      (request.method === 'POST' && ORGANIZATION_MODELS_VALIDATE.test(pathname))
    ) {
      await handleModelValidation(request, emit);
      return;
    }
    if (route === 'POST /api/openrouter/chat/completions') {
      await handleChatCompletions(request, emit, state);
      return;
    }
    if (route === 'POST /api/openrouter/audio/transcriptions') {
      await handleAudioTranscriptions(request, emit, state);
      return;
    }
    if (route === 'POST /test/release') {
      handleRelease(request, emit, state);
      return;
    }
    if (route === 'GET /test/gate-status') {
      handleGateStatus(request, emit, state);
      return;
    }
    if (route === 'GET /test/waiters') {
      handleWaiters(emit, state);
      return;
    }
    if (route === 'GET /test/requests') {
      handleRequestCounts(emit, state);
      return;
    }
    if (route === 'GET /test/scenario-status') {
      handleScenarioStatus(request, emit, state);
      return;
    }

    logEvent('request.unknown', { method: request.method, path: pathname });
    emit.json(404, { error: `not found: ${route}` });
  } catch (error) {
    // The adapter owns how a failure surfaces: JSON 500 before the response is
    // shaped, stream termination afterwards. `fail` never throws.
    emit.fail(error);
  }
}
