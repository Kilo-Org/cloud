/**
 * Adapter between the wrapper and the @kilocode/sdk client.
 *
 * Provides a stable `WrapperKiloClient` interface that all wrapper modules use.
 * The raw SDK client is not exposed on the returned interface — all access
 * goes through named methods.
 */

import type { KiloClient as SDKClient } from '@kilocode/sdk';
import {
  createKiloClient as createV2Client,
  type PermissionRequest,
  type PermissionRuleset,
  type QuestionRequest,
  type SessionCommandResponse,
  type SessionPromptResponse,
  type SessionMessagesResponse2,
  type SnapshotFileDiff,
  type SuggestionRequest,
  type Todo,
} from '@kilocode/sdk/v2';
import { z } from 'zod';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logToFile } from './utils.js';
import { kiloClientConfig, kiloServerHeaders, type KiloServer } from './kilo-server-auth.js';
import {
  boundSlashCommandCatalog,
  toSlashCommandInfo,
  type BoundedSlashCommandCatalog,
  type SlashCommandInfo,
} from '../../src/shared/slash-commands.js';
import { KILO_CLI_VERSION } from '../../src/shared/kilo-cli-version.js';
import { sessionChildSchema } from './control/session-child-schema.js';
import type { ControlPlaneSessionCredentialsPayload } from '../../src/shared/control-plane-protocol.js';

const sessionStatusesSchema = z.record(
  z.string().min(1),
  z.object({ type: z.string().min(1) }).passthrough()
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isKiloEvent(value: unknown): value is KiloEvent {
  return isRecord(value) && typeof value.type === 'string';
}

function isSyntheticKiloEvent(event: KiloEvent): boolean {
  return event.type === 'server.connected' || event.type === 'server.heartbeat';
}

/**
 * Codes raised by fetch when the server process cannot be reached — Node/undici
 * errno strings plus Bun's fetch codes, which have no errno equivalent.
 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ConnectionRefused',
  'ConnectionClosed',
  'FailedToOpenSocket',
]);

/** Transport-failure texts from fetch implementations that set no code. */
const UNREACHABLE_ERROR_PATTERN = /econnrefused|econnreset|fetch failed|unable to connect/i;

/** Bound on `cause` traversal, in case a chain is cyclic. */
const MAX_CAUSE_DEPTH = 5;

/**
 * True when a WrapperKiloClient call failed because the kilo server process
 * itself is gone (crashed, OOM-killed) rather than because it returned an
 * application-level error. Distinguishing the two matters: app-level errors
 * (bad session id, invalid model) must not trigger a runtime restart, but a
 * dead server should — see MEMORY_CGROUPS_PLAN.md (W5).
 *
 * Wrapper errors carry the original SDK failure as `cause`: an Error instance
 * when the transport failed, or the parsed response body (not an Error) when a
 * live server answered with an application error. Codes are checked at every
 * level of the chain, but the message pattern applies only to a leaf Error:
 * composed wrapper messages embed application text, and a live server relaying
 * an upstream failure may legitimately say "fetch failed" in its error body.
 */
export function isKiloServerUnreachableError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (code !== undefined && CONNECTION_ERROR_CODES.has(code)) return true;
    if (current.cause === undefined) return UNREACHABLE_ERROR_PATTERN.test(current.message);
    current = current.cause;
  }
  return false;
}

async function* globalFeedPayloads(
  stream: AsyncIterable<unknown>,
  workspacePath: string
): AsyncGenerator<KiloEvent> {
  for await (const envelope of stream) {
    if (!isRecord(envelope)) continue;
    const payload = envelope.payload;
    if (!isKiloEvent(payload)) continue;

    const directory = envelope.directory;
    if (isSyntheticKiloEvent(payload) || directory === workspacePath) {
      yield payload;
    }
  }
}

function providerIdFromRecord(provider: Record<string, unknown>): string | undefined {
  const id = provider.id ?? provider.providerID ?? provider.providerId;
  return typeof id === 'string' ? id : undefined;
}

function modelIdFromRecord(model: Record<string, unknown>): string | undefined {
  const id = model.id ?? model.modelID ?? model.modelId;
  return typeof id === 'string' ? id : undefined;
}

function modelKeysFromModels(models: unknown): string[] {
  if (isRecord(models)) return Object.keys(models);
  if (!Array.isArray(models)) return [];
  return models.flatMap(model => {
    if (typeof model === 'string') return [model];
    if (isRecord(model)) {
      const modelID = modelIdFromRecord(model);
      return modelID ? [modelID] : [];
    }
    return [];
  });
}

function modelKeysFromProvider(provider: unknown): string[] {
  if (!isRecord(provider)) return [];
  return modelKeysFromModels(provider.models);
}

function findProviderEntries(data: unknown, providerID: string): unknown[] {
  if (Array.isArray(data)) {
    return data.filter(
      provider => isRecord(provider) && providerIdFromRecord(provider) === providerID
    );
  }

  if (!isRecord(data)) return [];

  const providers = data.providers;
  if (Array.isArray(providers)) {
    const matchingProviders = providers.filter(
      entry => isRecord(entry) && providerIdFromRecord(entry) === providerID
    );
    if (matchingProviders.length > 0) return matchingProviders;
  }

  const directProvider = data[providerID];
  if (directProvider !== undefined) return [directProvider];

  return providerIdFromRecord(data) === providerID ? [data] : [];
}

function exactDedupedModelKeys(data: unknown, providerID: string): string[] {
  return [...new Set(findProviderEntries(data, providerID).flatMap(modelKeysFromProvider))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function formatSdkError(result: { response?: Response }): string {
  return result.response ? `HTTP ${result.response.status}` : 'request error';
}

function requireSdkData<T>(
  result: { data?: T; error?: unknown; response?: Response },
  operation: string
): T {
  if (result.error !== undefined) {
    throw new Error(`${operation} failed: ${formatSdkError(result)}`, {
      cause: result.error,
    });
  }

  if (result.data === undefined || result.data === null || result.response?.status === 204) {
    throw new Error(`${operation} returned no data`);
  }

  return result.data;
}

/**
 * The import committed the record but its ruleset could not be applied. The
 * record is in place, so retrying the session step would reuse it and return
 * without applying the ruleset; this error marks the failure as one a retry
 * cannot improve.
 */
export class SessionRulesetNotAppliedError extends Error {
  readonly sessionId: string;
  readonly retryable = false;

  constructor(sessionId: string, cause: unknown) {
    super(`Session ruleset not applied for ${sessionId}`, { cause });
    this.name = 'SessionRulesetNotAppliedError';
    this.sessionId = sessionId;
  }
}

/**
 * The native session update appends rules instead of replacing them, so a
 * ruleset a record already holds must not be sent again.
 *
 * `action` stays a plain string because a record or marker may carry an action
 * VALUE this build does not know, and refusing it would throw away the whole
 * ruleset instead of the one rule. The keys stay strict: the pinned server
 * strips unknown rule keys itself, so accepting them here would only widen what
 * this wrapper treats as a grant.
 */
const permissionRuleSchema = z.object({
  permission: z.string(),
  pattern: z.string(),
  action: z.string(),
});

// Parses a ruleset that arrives as JSON (a remembered marker) or as an
// unvalidated session-read field; a ruleset becomes permission grants, so it is
// never applied unparsed.
const permissionRulesetSchema = z.array(permissionRuleSchema);

/**
 * The ruleset `value` holds, or `undefined` when it is not a ruleset.
 *
 * The schema keeps `action` a plain string, because an action this build does
 * not know must drop nothing: the record's rules still parse, so they can still
 * be compared and applied. That leaves the parsed value wider than the SDK's
 * `'allow' | 'deny' | 'ask'`, so the result is narrowed once here, after
 * validation, instead of widening the schema.
 */
function parseRuleset(value: unknown): PermissionRuleset | undefined {
  const parsed = permissionRulesetSchema.safeParse(value);
  return parsed.success ? (parsed.data as PermissionRuleset) : undefined;
}

/**
 * Rulesets that a committed record still owes. The native import replaces the
 * row and its body cannot carry a ruleset, so the ruleset is applied right
 * after it. When that call fails, the record stays in place without its
 * rules; the next prepare must apply the ruleset before the route is reused,
 * not skip the call because the record is already there.
 *
 * The record lives in the sandbox, so the marker must outlive this process: a
 * wrapper restart inside a surviving allocation would otherwise lose it.
 */
function outstandingRulesetPath(sessionId: string): string {
  const home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : os.tmpdir();
  return path.join(home, '.kilo-control', 'rulesets', `${encodeURIComponent(sessionId)}.json`);
}

export async function rememberOutstandingRuleset(
  sessionId: string,
  permission: PermissionRuleset
): Promise<void> {
  const file = outstandingRulesetPath(sessionId);
  const directory = path.dirname(file);
  // Write beside the target and rename, so a kill mid-write cannot leave a
  // truncated marker that reads as "nothing owed".
  const temporary = path.join(directory, `${encodeURIComponent(sessionId)}.${process.pid}.tmp`);
  try {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(temporary, JSON.stringify(permission), { mode: 0o600 });
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    // The record is already committed, so a marker that cannot be stored is
    // the same failure as a ruleset that could not be applied.
    throw new SessionRulesetNotAppliedError(sessionId, error);
  }
}

export async function forgetOutstandingRuleset(sessionId: string): Promise<void> {
  await fsp.rm(outstandingRulesetPath(sessionId), { force: true });
}

export async function readOutstandingRuleset(
  sessionId: string
): Promise<PermissionRuleset | undefined> {
  try {
    const raw = await fsp.readFile(outstandingRulesetPath(sessionId), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    // Present but unreadable is still owed: never treat a damaged marker as
    // permission to accept the record. A marker that is present but not a
    // ruleset fails the route instead of reading as nothing owed, because
    // reading it as nothing owed would drop a ruleset that is still owed.
    const ruleset = parseRuleset(parsed);
    if (ruleset !== undefined) return ruleset;
    throw new Error(`Outstanding ruleset for ${sessionId} is malformed`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A marker that exists but cannot be read reports the same final failure,
    // so the route does not prepare on an assumption about its ruleset.
    throw new SessionRulesetNotAppliedError(sessionId, error);
  }
}

export async function hasOutstandingRuleset(sessionId: string): Promise<boolean> {
  return (await readOutstandingRuleset(sessionId)) !== undefined;
}

/**
 * The parts of a session read that decide which record the read describes.
 * `permission` is parsed separately, because a record that carries permission
 * data which is not a ruleset is still this route's record: failing the whole
 * parse would read it as absent and the caller would prepare without the rules.
 */
const storedSessionSchema = z.object({ directory: z.string() }).passthrough();

/** True when every rule of `permission` is already present in `stored`. */
function rulesetCovers(
  stored: ReadonlyArray<{ permission: string; pattern: string; action: string }>,
  permission: PermissionRuleset
): boolean {
  return permission.every(rule =>
    stored.some(
      entry =>
        entry.permission === rule.permission &&
        entry.pattern === rule.pattern &&
        entry.action === rule.action
    )
  );
}

/**
 * What a session read says about a ruleset the caller wants to apply. The
 * record's directory is part of the answer: an update scoped to this route's
 * directory does not reach a record stored under another one. `invalid` is a
 * record this route owns whose `permission` is present but is not a ruleset:
 * the rules can be neither compared nor applied, so the caller must fail.
 */
type StoredRuleset = 'absent' | 'holds' | 'invalid' | 'missing';

/**
 * A record that names the route directory but carries a permission that is not
 * a ruleset cannot have its rules applied, so every path that would prepare
 * from it fails instead of preparing without the rules.
 */
function invalidRecordRuleset(sessionId: string): SessionRulesetNotAppliedError {
  return new SessionRulesetNotAppliedError(
    sessionId,
    new Error(`Session record for ${sessionId} carries a permission that is not a ruleset`)
  );
}

/**
 * A record that does not exist, and a read that cannot answer, leave the caller
 * free to update: the update reports the real failure itself.
 */
async function storedRulesetFor(
  sessionId: string,
  directory: string,
  read: () => Promise<{ data?: unknown; error?: unknown; response?: Response }>,
  permission: PermissionRuleset
): Promise<StoredRuleset> {
  try {
    const current = await read();
    if (current.response?.status === 404) return 'absent';
    // The read is unvalidated JSON, so the parts the decision uses are parsed.
    const record = storedSessionSchema.safeParse(
      requireSdkData(current, `Session get for ${sessionId}`)
    );
    // A record under another directory is not this route's session: its rules
    // belong to that directory, and the import re-points it separately.
    if (!record.success || !(await sameDirectory(record.data.directory, directory))) {
      return 'absent';
    }
    const stored = record.data.permission;
    if (stored === undefined) return 'missing';
    // The record names this directory, so a permission that is not a ruleset is
    // a record the caller cannot settle: neither "absent" nor "missing" may be
    // reported, because both would let the route prepare without the rules.
    const ruleset = parseRuleset(stored);
    if (ruleset === undefined) return 'invalid';
    return rulesetCovers(ruleset, permission) ? 'holds' : 'missing';
  } catch {
    return 'missing';
  }
}

export type DrainSessionErrorKind =
  | 'transient'
  | 'definitive'
  | 'anomalous'
  | 'unclassified'
  | 'quiet_drain';

/**
 * A classified drain failure. Transport-level retry policy reads `kind`; the
 * caller never parses an HTTP status out of the message.
 */
export class DrainSessionError extends Error {
  readonly kind: DrainSessionErrorKind;
  readonly status?: number;

  constructor(
    kind: DrainSessionErrorKind,
    message: string,
    options?: { status?: number; cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DrainSessionError';
    this.kind = kind;
    if (options?.status !== undefined) this.status = options.status;
  }
}

export type KiloServerHandle = {
  url: string;
  close: () => void;
};

/**
 * Permission response type.
 */
export type PermissionResponse = 'always' | 'once' | 'reject';

export type NetworkWait = {
  id: string;
  sessionID: string;
  message: string;
  restored: boolean;
};

export type WrapperPty = {
  id: string;
  title: string;
  command: string;
  args: string[];
  cwd: string;
  status: 'running' | 'exited';
  pid: number;
};

export type WrapperPtySize = {
  cols: number;
  rows: number;
};

/**
 * Whether two directory strings name the same place. The native server stores
 * realpath-canonical paths, so a route reached through a symlink or a trailing
 * slash would otherwise never match its own record. A path that no longer
 * resolves falls back to the resolved form of the string itself.
 */
export async function sameDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> => {
    try {
      return await fsp.realpath(value);
    } catch {
      return path.resolve(value);
    }
  };
  const [a, b] = await Promise.all([canonical(left), canonical(right)]);
  return a === b;
}

export type KiloSessionMetadata = { id: string; directory: string; parentID?: string };
export const KILO_ACTIVITY_MESSAGE_LIMIT = 32;
export const KILO_ACTIVITY_DISCOVERY_LIMIT = 1_000;

/**
 * Shape of an event yielded by `subscribeEvents().stream`. The wrapper unwraps
 * the SDK global event envelope before handing events to `connection.ts`, which
 * only reads `type` and `properties`.
 */
export type KiloEvent = {
  type?: string;
  properties?: Record<string, unknown>;
};

type PromptOptions = {
  sessionId: string;
  messageId: string;
  parts?: Array<
    { type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string }
  >;
  prompt?: string;
  /** Server-owned context sent as a synthetic text part before the prompt. */
  context?: string;
  variant?: string;
  agent?: string;
  model?: { providerID?: string; modelID: string };
  system?: string;
  tools?: Record<string, boolean>;
  directory?: string;
  signal?: AbortSignal;
};

/**
 * The wrapper's unified kilo client interface.
 * All wrapper modules depend on this type rather than the raw SDK client.
 */
export type WrapperKiloClient = {
  updateCloudAgentMcp: (
    grant: NonNullable<ControlPlaneSessionCredentialsPayload['cloudAgentMcp']>,
    signal?: AbortSignal
  ) => Promise<void>;
  createSession: (opts?: { title?: string }) => Promise<{ id: string }>;
  getSession: (sessionId: string) => Promise<{ id: string }>;
  getSessionDetails: (
    sessionId: string,
    directory: string,
    signal?: AbortSignal
  ) => Promise<KiloSessionMetadata>;
  /** Process-wide metadata discovery; no default directory filter. Fails on truncation. */
  listSessionMetadata: (signal: AbortSignal) => Promise<KiloSessionMetadata[]>;
  /** Bounded recent window; callers must not interpret a partial window as all execution. */
  getRecentSessionMessages: (
    sessionId: string,
    directory: string,
    signal: AbortSignal
  ) => Promise<SessionMessagesResponse2>;
  getSessionMessage: (
    sessionId: string,
    directory: string,
    messageId: string,
    signal: AbortSignal
  ) => Promise<SessionMessagesResponse2[number]>;
  getSuggestions: (directory: string, signal: AbortSignal) => Promise<SuggestionRequest[]>;
  /** Metadata only; never return tool input or output to diagnostics. */
  probeMessagePart?: (
    sessionId: string,
    directory: string,
    messageId: string,
    partId: string,
    signal: AbortSignal
  ) => Promise<{ status: string; outputBytes?: number } | null>;
  ensureSession: (sessionId: string, directory: string, signal?: AbortSignal) => Promise<void>;
  /** Applies a ruleset a committed record still owes, if any. */
  settleOutstandingRuleset: (
    sessionId: string,
    directory: string,
    signal?: AbortSignal
  ) => Promise<void>;
  sendPrompt: (opts: PromptOptions) => Promise<SessionPromptResponse>;
  sendPromptAsync: (opts: PromptOptions) => Promise<void>;
  abortSession: (opts: {
    sessionId: string;
    directory?: string;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  /** Direct child sessions forked from one session, for release tree cleanup. */
  children: (opts: {
    sessionId: string;
    directory: string;
    signal?: AbortSignal;
  }) => Promise<Array<{ id: string; directory: string }>>;
  /**
   * Abort a session during release cleanup. A 404 is success: the session is
   * already gone, so there is nothing left to abort.
   */
  abortSessionForCleanup: (opts: {
    sessionId: string;
    directory: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  /** Stops and forgets every background process owned by one session. */
  stopSessionProcesses: (opts: {
    sessionId: string;
    directory: string;
    signal?: AbortSignal;
  }) => Promise<void>;
  drainSession: (opts: {
    sessionId: string;
    directory?: string;
    token?: string;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  summarizeSession: (opts: {
    sessionId: string;
    model: { providerID?: string; modelID: string };
    auto?: boolean;
    directory?: string;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  sendCommand: (opts: {
    sessionId: string;
    command: string;
    args?: string;
    messageId?: string;
    agent?: string;
    model?: { providerID?: string; modelID: string };
    variant?: string;
    directory?: string;
    signal?: AbortSignal;
  }) => Promise<SessionCommandResponse>;
  /**
   * Fetch the full slash command catalog from kilo, trimmed to wire shape and
   * bounded to the shared limits. The bound status is returned beside the
   * commands so the client can be told when rows were dropped.
   */
  listCommands: () => Promise<BoundedSlashCommandCatalog>;
  answerPermission: (
    permissionId: string,
    response: PermissionResponse,
    message?: string,
    interactive?: boolean,
    directory?: string,
    signal?: AbortSignal
  ) => Promise<boolean>;
  answerQuestion: (
    questionId: string,
    answers: string[][],
    directory?: string,
    signal?: AbortSignal
  ) => Promise<boolean>;
  rejectQuestion: (
    questionId: string,
    directory?: string,
    signal?: AbortSignal
  ) => Promise<boolean>;
  getSessionStatuses: (
    directory?: string,
    signal?: AbortSignal
  ) => Promise<Record<string, { type: string; [key: string]: unknown }>>;
  getQuestions: (directory?: string, signal?: AbortSignal) => Promise<QuestionRequest[]>;
  getPermissions: (directory?: string, signal?: AbortSignal) => Promise<PermissionRequest[]>;
  getSessionTodos: (sessionID: string, directory?: string, signal?: AbortSignal) => Promise<Todo[]>;
  getSessionDiff: (
    sessionID: string,
    directory?: string,
    signal?: AbortSignal
  ) => Promise<SnapshotFileDiff[]>;
  getNetworkWaits: () => Promise<NetworkWait[]>;
  resumeNetworkWait: (requestID: string) => Promise<boolean>;
  listEffectiveModels: (providerID: string) => Promise<string[]>;
  generateCommitMessage: (opts: {
    path: string;
    signal?: AbortSignal;
  }) => Promise<{ message: string }>;
  createPty: (opts: {
    cwd: string;
    title: string;
    env: Record<string, string>;
  }) => Promise<WrapperPty>;
  resizePty: (ptyId: string, size: WrapperPtySize, directory?: string) => Promise<WrapperPty>;
  deletePty: (ptyId: string, directory?: string) => Promise<boolean>;
  connectPty: (ptyId: string, directory: string) => WebSocket;

  /**
   * Subscribe to kilo events. The stream yields typed events until the abort
   * signal fires or the server closes the stream. Used by connection.ts.
   */
  subscribeEvents: (opts: { signal?: AbortSignal }) => Promise<{
    stream?: AsyncIterable<KiloEvent>;
  }>;
  /** The in-process server URL — for diagnostics */
  readonly serverUrl: string;
  /** The server and its credential; raw requests and sockets must use both. */
  readonly server: KiloServer;
};

export function createWrapperKiloClient(
  sdkClient: SDKClient,
  server: KiloServer,
  workspacePath: string
): WrapperKiloClient {
  const serverUrl = server.url;
  logToFile(`creating wrapper kilo client for ${serverUrl}`);
  const v2Client = createV2Client(kiloClientConfig(server, workspacePath));
  const globalClient = createV2Client(kiloClientConfig(server));

  function promptParameters(opts: PromptOptions) {
    const rawParts =
      opts.parts ?? (opts.prompt ? [{ type: 'text' as const, text: opts.prompt }] : []);
    const parts = [
      ...(opts.context
        ? [{ type: 'text' as const, text: opts.context, synthetic: true as const }]
        : []),
      ...rawParts,
    ];
    return {
      sessionID: opts.sessionId,
      directory: opts.directory ?? workspacePath,
      messageID: opts.messageId,
      parts: parts.map(part =>
        part.type === 'file'
          ? {
              type: 'file' as const,
              mime: part.mime,
              url: part.url,
              ...(part.filename ? { filename: part.filename } : {}),
            }
          : {
              type: 'text' as const,
              text: part.text,
              ...('synthetic' in part ? { synthetic: true as const } : {}),
            }
      ),
      ...(opts.variant ? { variant: opts.variant } : {}),
      ...(opts.model
        ? { model: { providerID: opts.model.providerID ?? 'kilo', modelID: opts.model.modelID } }
        : {}),
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
    };
  }

  return {
    serverUrl,
    server,
    updateCloudAgentMcp: async (grant, signal) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        signal?.throwIfAborted();
        try {
          const result = await v2Client.mcp.add(
            {
              directory: workspacePath,
              name: 'kilo-cloud-agent',
              config: {
                type: 'remote',
                url: grant.url,
                oauth: false,
                headers: { Authorization: `Bearer ${grant.token}` },
              },
            },
            { signal }
          );
          if (!result.error && result.data?.['kilo-cloud-agent']?.status === 'connected') return;
        } catch {
          signal?.throwIfAborted();
        }
      }
      throw new Error('Cloud Agent MCP credential refresh failed');
    },

    subscribeEvents: async opts => {
      const result = await v2Client.global.event({ signal: opts.signal });
      return {
        stream: result.stream ? globalFeedPayloads(result.stream, workspacePath) : undefined,
      };
    },

    createSession: async opts => {
      const result = await sdkClient.session.create({
        body: { title: opts?.title },
        query: { directory: workspacePath },
      });
      const data = requireSdkData(result, 'Session create');
      return { id: data.id };
    },

    getSession: async sessionId => {
      const result = await sdkClient.session.get({
        path: { id: sessionId },
        query: { directory: workspacePath },
      });
      const data = requireSdkData(result, `Session get for ${sessionId}`);
      return { id: data.id };
    },

    getSessionDetails: async (sessionId, directory, signal) => {
      const result = await v2Client.session.get({ sessionID: sessionId, directory }, { signal });
      const data = requireSdkData(result, 'Session cleanup lookup');
      if (data.id !== sessionId || data.directory !== directory) {
        throw new Error('Session cleanup lookup returned an invalid session');
      }
      return {
        id: data.id,
        directory: data.directory,
        ...(data.parentID ? { parentID: data.parentID } : {}),
      };
    },

    listSessionMetadata: async signal => {
      // The timestamp-only pagination cursor can skip equal-timestamp rows. Require
      // a complete bounded page rather than silently missing an execution directory.
      const result = await globalClient.experimental.session.list(
        { limit: KILO_ACTIVITY_DISCOVERY_LIMIT, archived: true },
        { signal }
      );
      const sessions = requireSdkData(result, 'Activity session discovery');
      if (result.response?.headers.has('x-next-cursor')) {
        throw new Error('Activity session discovery exceeded its bounded complete window');
      }
      return sessions.map(({ id, directory, parentID }) => ({
        id,
        directory,
        ...(parentID ? { parentID } : {}),
      }));
    },

    getRecentSessionMessages: async (sessionId, directory, signal) => {
      const result = await v2Client.session.messages(
        { sessionID: sessionId, directory, limit: KILO_ACTIVITY_MESSAGE_LIMIT },
        { signal }
      );
      return requireSdkData(result, 'Activity session messages');
    },

    getSessionMessage: async (sessionId, directory, messageId, signal) => {
      const result = await v2Client.session.message(
        { sessionID: sessionId, directory, messageID: messageId },
        { signal }
      );
      return requireSdkData(result, 'Activity session message');
    },

    getSuggestions: async (directory, signal) => {
      const result = await v2Client.suggestion.list({ directory }, { signal });
      return requireSdkData(result, 'Activity suggestions');
    },

    probeMessagePart: async (sessionId, directory, messageId, partId, signal) => {
      const result = await v2Client.session.message(
        { sessionID: sessionId, messageID: messageId, directory },
        { signal }
      );
      if (result.response?.status === 404) return null;
      const message = requireSdkData(result, 'Session message probe');
      const part = message.parts.find(item => item.id === partId);
      if (part?.type !== 'tool') return null;
      return {
        status: part.state.status,
        ...(part.state.status === 'completed'
          ? { outputBytes: Buffer.byteLength(part.state.output, 'utf8') }
          : {}),
      };
    },

    ensureSession: async (sessionId, directory, signal) => {
      // The caller records the obligation before the import commits the row, so
      // a transient failure on this second call is retried here: the enclosing
      // step retry would find the record in place and return early.
      const applyRuleset = async (permission: PermissionRuleset): Promise<void> => {
        const attemptOnce = async () => {
          const restoreTimeout = AbortSignal.timeout(8_000);
          const restored = await v2Client.session.update(
            { sessionID: sessionId, directory, permission },
            { signal: signal ? AbortSignal.any([signal, restoreTimeout]) : restoreTimeout }
          );
          requireSdkData(restored, `Session permission restore for ${sessionId}`);
        };
        // A marker that cannot be cleared is retried by the next prepare, whose
        // check finds the stored rules and does not duplicate them.
        const clearMarker = () => forgetOutstandingRuleset(sessionId).catch(() => undefined);
        const settled = () => {
          const readTimeout = AbortSignal.timeout(8_000);
          return storedRulesetFor(
            sessionId,
            directory,
            () =>
              v2Client.session.get(
                { sessionID: sessionId, directory },
                { signal: signal ? AbortSignal.any([signal, readTimeout]) : readTimeout }
              ),
            permission
          );
        };
        const state = await settled();
        if (state === 'holds') {
          await clearMarker();
          return;
        }
        // A record this route owns whose permission is not a ruleset cannot have
        // the rules compared or applied, so the route fails instead of updating
        // it and leaving the marker cleared.
        if (state === 'invalid') throw invalidRecordRuleset(sessionId);
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await attemptOnce();
            await clearMarker();
            return;
          } catch (error) {
            lastError = error;
            if (signal?.aborted) break;
            // A failed attempt may still have applied the update, so check the
            // record before repeating it and never store the ruleset twice.
            const recheck = await settled();
            if (recheck === 'holds') {
              await clearMarker();
              return;
            }
            // A record that now reads as carrying a permission which is not a
            // ruleset must not be updated again: the marker stays and the route
            // fails the same way the create path does.
            if (recheck === 'invalid') throw invalidRecordRuleset(sessionId);
            if (attempt < 3) {
              const { promise, resolve } = Promise.withResolvers<void>();
              setTimeout(resolve, 50 * attempt);
              await promise;
            }
          }
        }
        // The record is already in place, so a step retry would reuse it and
        // skip this call. The outstanding entry makes the next prepare apply
        // the ruleset instead of accepting the record as complete.
        throw new SessionRulesetNotAppliedError(sessionId, lastError);
      };
      const lookupTimeout = AbortSignal.timeout(5_000);
      const lookupSignal = signal ? AbortSignal.any([signal, lookupTimeout]) : lookupTimeout;
      const existing = await v2Client.session.get(
        { sessionID: sessionId, directory },
        { signal: lookupSignal }
      );
      // A record outside this directory is not this route's session. The
      // native import re-points a record it already holds only when the caller
      // sets `force`, so the mismatch case sets it and the absent case does not.
      const record =
        existing.response?.status === 404
          ? undefined
          : requireSdkData(existing, `Session get for ${sessionId}`);
      if (record) {
        if (record.id !== sessionId) {
          throw new Error(`Session get for ${sessionId} returned an invalid session`);
        }
        if (
          typeof record.directory === 'string' &&
          (await sameDirectory(record.directory, directory))
        ) {
          // A record that still owes its ruleset is not complete: apply it
          // before the route is reused instead of returning as if it were.
          const owed = await readOutstandingRuleset(sessionId);
          if (owed === undefined) return;
          await applyRuleset(owed);
          return;
        }
      }
      const currentProject = await v2Client.project.current(
        { directory },
        { signal: lookupSignal }
      );
      const project = requireSdkData(currentProject, `Current project for session ${sessionId}`);
      if (typeof project.id !== 'string' || project.id.length === 0) {
        throw new Error(`Current project for session ${sessionId} returned an invalid project`);
      }
      const now = Date.now();
      const importTimeout = AbortSignal.timeout(8_000);
      const recordRuleset =
        record?.permission === undefined ? undefined : parseRuleset(record.permission);
      // A record that carries permission data which is not a ruleset cannot have
      // its rules applied, so the route fails instead of preparing without them.
      if (record?.permission !== undefined && recordRuleset === undefined) {
        throw invalidRecordRuleset(sessionId);
      }
      // The obligation is already durable when the marker covers what the record
      // carries, so it is not rewritten: a directory that refuses the write must
      // not fail a route whose ruleset is already recorded.
      const remembered = await readOutstandingRuleset(sessionId);
      if (
        recordRuleset !== undefined &&
        (remembered === undefined || !rulesetCovers(remembered, recordRuleset))
      ) {
        // The import replaces the record's own ruleset, so the obligation must be
        // stored before the import commits the row.
        await rememberOutstandingRuleset(sessionId, recordRuleset);
      }
      const owed = recordRuleset ?? remembered;
      const imported = await v2Client.kilocode.sessionImport.session(
        {
          query_directory: directory,
          body_directory: directory,
          id: sessionId,
          projectID: project.id,
          slug: sessionId.slice(0, 24),
          // A re-pointed record keeps the fields it already carries.
          title: record?.title ?? 'New session - ' + new Date(now).toISOString(),
          version: KILO_CLI_VERSION,
          ...(record ? { force: true } : {}),
          ...(record?.workspaceID === undefined ? {} : { workspaceID: record.workspaceID }),
          ...(record?.parentID === undefined ? {} : { parentID: record.parentID }),
          ...(record?.share === undefined ? {} : { shareURL: record.share.url }),
          ...(record?.summary === undefined ? {} : { summary: record.summary }),
          ...(record?.revert === undefined ? {} : { revert: record.revert }),
          timeCreated: record?.time?.created ?? now,
          timeUpdated: record?.time?.updated ?? now,
          ...(record?.time?.compacting === undefined
            ? {}
            : { timeCompacting: record.time.compacting }),
          ...(record?.time?.archived === undefined ? {} : { timeArchived: record.time.archived }),
        },
        { signal: signal ? AbortSignal.any([signal, importTimeout]) : importTimeout }
      );
      const data = requireSdkData(imported, `Session import for ${sessionId}`);
      if (!data.ok || data.id !== sessionId) {
        throw new Error(`Session import for ${sessionId} returned an invalid session`);
      }
      // The import body types `permission` as a string map, while a record
      // carries a ruleset, so the ruleset is applied through the update
      // endpoint that accepts it. The read is unvalidated JSON, so check the
      // shape before applying it. The import has already committed the record,
      // so a transient failure here must not leave a route that prepares
      // without the record's rules; retry within this call, because the step
      // retry above would find the record in place and return before reaching
      // this point again.
      if (owed !== undefined) await applyRuleset(owed);
      // The import body cannot carry metadata: the key is accepted and dropped
      // silently, which leaves the column NULL. Metadata holds the session goal
      // the UI shows, so it is restored from the pre-import read. The update
      // replaces the object wholesale, so the whole value goes back. The
      // record's agent and model are not restored: they are only a mirror, and
      // every prompt carries its own from the turn payload. The import has
      // already committed the record and metadata carries no authorization
      // decision, so a failed restore is skipped rather than failing the route.
      if (record?.metadata !== undefined) {
        try {
          const restoreTimeout = AbortSignal.timeout(8_000);
          const restored = await v2Client.session.update(
            { sessionID: sessionId, directory, metadata: record.metadata },
            { signal: signal ? AbortSignal.any([signal, restoreTimeout]) : restoreTimeout }
          );
          requireSdkData(restored, `Session metadata restore for ${sessionId}`);
        } catch {
          // The record is committed and this route may proceed without it.
        }
      }
    },

    settleOutstandingRuleset: async (sessionId, directory, signal) => {
      const owed = await readOutstandingRuleset(sessionId);
      if (owed === undefined) return;
      const readTimeout = AbortSignal.timeout(8_000);
      const read = () =>
        v2Client.session.get(
          { sessionID: sessionId, directory },
          { signal: signal ? AbortSignal.any([signal, readTimeout]) : readTimeout }
        );
      const stored = await storedRulesetFor(sessionId, directory, read, owed);
      // A record under another directory belongs to that directory until the
      // import re-points it, and an absent record has nothing to apply to, so
      // the marker stays for the create path in both cases.
      if (stored === 'absent') return;
      // A record that names this directory but carries a permission which is not
      // a ruleset cannot have the rules applied, so the route fails the way the
      // create path does. The record is left unchanged, so the marker stays and
      // the next prepare fails the same way instead of preparing without them.
      if (stored === 'invalid') throw invalidRecordRuleset(sessionId);
      // A record that already holds the rules is not updated again, because the
      // update appends them; the marker is cleared instead. A marker that cannot
      // be cleared is retried by the next prepare, which then finds the stored
      // rules and does not duplicate them.
      if (stored === 'missing') {
        const restoreTimeout = AbortSignal.timeout(8_000);
        const restored = await v2Client.session.update(
          { sessionID: sessionId, directory, permission: owed },
          { signal: signal ? AbortSignal.any([signal, restoreTimeout]) : restoreTimeout }
        );
        requireSdkData(restored, `Session permission restore for ${sessionId}`);
      }
      await forgetOutstandingRuleset(sessionId).catch(() => undefined);
    },

    sendPrompt: async opts => {
      const result = await v2Client.session.prompt(promptParameters(opts), { signal: opts.signal });
      return requireSdkData(result, `Prompt for session ${opts.sessionId}`);
    },

    sendPromptAsync: async opts => {
      const result = await v2Client.session.promptAsync(promptParameters(opts), {
        signal: opts.signal,
      });
      if (result.error !== undefined) {
        throw new Error(
          `Async prompt for session ${opts.sessionId} failed: ${formatSdkError(result)}`,
          { cause: result.error }
        );
      }
    },

    abortSession: async opts => {
      const result = await v2Client.session.abort(
        { sessionID: opts.sessionId, directory: opts.directory ?? workspacePath, scope: 'tree' },
        { signal: opts.signal }
      );
      const operation = `Session abort for ${opts.sessionId}`;
      const data = requireSdkData<unknown>(result, operation);
      if (typeof data !== 'boolean') {
        throw new Error(`${operation} returned no boolean result`);
      }
      return data;
    },

    children: async opts => {
      const result = await v2Client.session.children(
        { sessionID: opts.sessionId, directory: opts.directory },
        { signal: opts.signal }
      );
      const data = requireSdkData(result, `Session children for ${opts.sessionId}`);
      return z.array(sessionChildSchema).parse(data);
    },

    abortSessionForCleanup: async opts => {
      const result = await v2Client.session.abort(
        { sessionID: opts.sessionId, directory: opts.directory },
        { signal: opts.signal }
      );
      // A missing session is already aborted; do not retry a 404.
      if (result.response?.status === 404) return;
      const operation = `Cleanup abort for ${opts.sessionId}`;
      const data = requireSdkData<unknown>(result, operation);
      if (data !== true) {
        throw new Error(`${operation} returned no boolean result`);
      }
    },

    stopSessionProcesses: async opts => {
      const result = await v2Client.backgroundProcess.stopSession(
        { sessionID: opts.sessionId, directory: opts.directory },
        { signal: opts.signal }
      );
      const operation = `Stop session processes for ${opts.sessionId}`;
      const data = requireSdkData<unknown>(result, operation);
      if (data !== true) {
        throw new Error(`${operation} returned no boolean result`);
      }
    },

    drainSession: async opts => {
      let result: Awaited<ReturnType<typeof v2Client.kilocode.drainSession>>;
      try {
        result = await v2Client.kilocode.drainSession(
          {
            sessionID: opts.sessionId,
            directory: opts.directory ?? workspacePath,
            token: opts.token ?? crypto.randomUUID(),
          },
          { signal: opts.signal, throwOnError: false }
        );
      } catch (error) {
        if (opts.signal?.aborted) {
          if (error instanceof Error) throw error;
          throw new DOMException('Aborted', 'AbortError');
        }
        throw new DrainSessionError('unclassified', 'protocol error', { cause: error });
      }
      const status: number | undefined = result.response?.status;
      if (opts.signal?.aborted) {
        if (result.error instanceof Error) throw result.error;
        throw new DOMException('Aborted', 'AbortError');
      }
      if (result.error !== undefined) {
        if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
          throw new DrainSessionError('transient', `HTTP ${status}`, {
            status,
            cause: result.error,
          });
        }
        if (status !== undefined && status >= 400 && status < 500) {
          throw new DrainSessionError('definitive', `HTTP ${status}`, {
            status,
            cause: result.error,
          });
        }
        if (result.response === undefined) {
          throw new DrainSessionError('transient', 'request error', { cause: result.error });
        }
        throw new DrainSessionError('unclassified', 'protocol error', { cause: result.error });
      }
      if (status === 204 || typeof result.data !== 'boolean') {
        throw new DrainSessionError('anomalous', 'returned no boolean result');
      }
      if (result.data === false) {
        throw new DrainSessionError('anomalous', 'Session drain returned false');
      }
      return result.data;
    },

    summarizeSession: async opts => {
      const result = await v2Client.session.summarize(
        {
          sessionID: opts.sessionId,
          directory: opts.directory ?? workspacePath,
          providerID: opts.model.providerID ?? 'kilo',
          modelID: opts.model.modelID,
          ...(opts.auto !== undefined ? { auto: opts.auto } : {}),
        },
        { signal: opts.signal }
      );
      const operation = `Session summarize for ${opts.sessionId}`;
      const data = requireSdkData<unknown>(result, operation);
      if (typeof data !== 'boolean') {
        throw new Error(`${operation} returned no boolean result`);
      }
      return data;
    },

    sendCommand: async opts => {
      const result = await v2Client.session.command(
        {
          sessionID: opts.sessionId,
          directory: opts.directory ?? workspacePath,
          command: opts.command,
          arguments: opts.args ?? '',
          ...(opts.messageId !== undefined ? { messageID: opts.messageId } : {}),
          ...(opts.agent ? { agent: opts.agent } : {}),
          ...(opts.model
            ? { model: `${opts.model.providerID ?? 'kilo'}/${opts.model.modelID}` }
            : {}),
          ...(opts.variant ? { variant: opts.variant } : {}),
        },
        { signal: opts.signal }
      );
      return requireSdkData(result, `Command for session ${opts.sessionId}`);
    },

    listCommands: async () => {
      const result = await sdkClient.command.list({ query: { directory: workspacePath } });
      const raw = requireSdkData(result, 'Command list');
      const commands: SlashCommandInfo[] = [];
      for (const item of raw) {
        const trimmed = toSlashCommandInfo(item);
        // Skill-sourced rows stay in the catalog: the mobile composer lists
        // and invokes them like any other command. The CLI reports a skill
        // only when it is available to this session, so keeping every reported
        // row never un-hides an unavailable skill.
        if (trimmed) commands.push(trimmed);
      }
      // Bound the catalog the same way the remote catalog is bounded. The
      // bound drops non-skill rows first and never truncates a skill row; a
      // full catalog carries its status to the client rather than hiding
      // skills silently.
      const bounded = boundSlashCommandCatalog(commands);
      if (bounded.dropped > 0 || bounded.overLimit) {
        logToFile(
          bounded.overLimit
            ? `slash command catalog over limit: kept all ${bounded.commands.length} rows (skill rows are never truncated), dropped ${bounded.dropped}`
            : `slash command catalog full: dropped ${bounded.dropped} non-skill rows, kept ${bounded.commands.length}`
        );
      }
      return bounded;
    },

    answerPermission: async (
      permissionId,
      response,
      message,
      interactive,
      directory = workspacePath,
      signal
    ) => {
      const result = await v2Client.permission.reply(
        { requestID: permissionId, directory, reply: response, message, interactive },
        { signal }
      );
      return requireSdkData(result, `Permission reply ${permissionId}`);
    },

    answerQuestion: async (questionId, answers, directory = workspacePath, signal) => {
      const result = await v2Client.question.reply(
        { requestID: questionId, answers, directory },
        { signal }
      );
      return requireSdkData(result, `Question reply ${questionId}`);
    },

    rejectQuestion: async (questionId, directory = workspacePath, signal) => {
      const result = await v2Client.question.reject(
        { requestID: questionId, directory },
        { signal }
      );
      return requireSdkData(result, `Question reject ${questionId}`);
    },

    getSessionStatuses: async (directory = workspacePath, signal) => {
      const result = await v2Client.session.status({ directory }, { signal });
      const parsed = sessionStatusesSchema.safeParse(requireSdkData(result, 'Session status'));
      if (!parsed.success) throw new Error('Session status returned an invalid map');
      return parsed.data;
    },

    getQuestions: async (directory = workspacePath, signal) => {
      const result = await v2Client.question.list({ directory }, { signal });
      return requireSdkData(result, 'Question list');
    },

    getPermissions: async (directory = workspacePath, signal) => {
      const result = await v2Client.permission.list({ directory }, { signal });
      return requireSdkData(result, 'Permission list');
    },

    getSessionTodos: async (sessionID, directory = workspacePath, signal) => {
      const result = await v2Client.session.todo({ sessionID, directory }, { signal });
      return requireSdkData(result, `Session todo ${sessionID}`);
    },

    getSessionDiff: async (sessionID, directory = workspacePath, signal) => {
      const result = await v2Client.session.diff({ sessionID, directory }, { signal });
      return requireSdkData(result, `Session diff ${sessionID}`);
    },

    getNetworkWaits: async () => {
      const result = await v2Client.network.list({ directory: workspacePath });
      return requireSdkData(result, 'Network list');
    },

    resumeNetworkWait: async requestID => {
      const result = await v2Client.network.reply({ requestID, directory: workspacePath });
      return requireSdkData(result, `Network reply ${requestID}`);
    },

    listEffectiveModels: async providerID => {
      const result = await v2Client.config.providers({
        directory: workspacePath,
        workspace: workspacePath,
      });
      const data = requireSdkData<unknown>(result, 'Config providers');
      return exactDedupedModelKeys(data, providerID);
    },

    generateCommitMessage: async opts => {
      const result = await v2Client.commitMessage.generate(
        { path: opts.path, directory: workspacePath },
        { signal: opts.signal }
      );
      return requireSdkData(result, 'Commit message generation');
    },

    createPty: async opts => {
      const result = await v2Client.pty.create({
        directory: opts.cwd,
        cwd: opts.cwd,
        title: opts.title,
        env: opts.env,
      });
      return requireSdkData(result, 'PTY create');
    },

    resizePty: async (ptyId, size, directory = workspacePath) => {
      const result = await v2Client.pty.update({
        ptyID: ptyId,
        directory,
        size,
      });
      return requireSdkData(result, `PTY update for ${ptyId}`);
    },

    deletePty: async (ptyId, directory = workspacePath) => {
      const result = await v2Client.pty.remove({
        ptyID: ptyId,
        directory,
      });
      return requireSdkData(result, `PTY delete for ${ptyId}`);
    },
    connectPty: (ptyId, directory) => {
      const url = new URL(`/pty/${encodeURIComponent(ptyId)}/connect`, server.url);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.search = '';
      url.hash = '';
      url.searchParams.set('directory', directory);
      const Socket = WebSocket as typeof WebSocket & {
        new (url: string, options: { headers: Record<string, string> }): WebSocket;
      };
      return new Socket(url.toString(), { headers: kiloServerHeaders(server) });
    },
  };
}
