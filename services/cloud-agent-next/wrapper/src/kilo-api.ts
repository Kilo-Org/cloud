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
  type QuestionRequest,
  type SessionCommandResponse,
  type SessionPromptResponse,
} from '@kilocode/sdk/v2';
import { z } from 'zod';
import { logToFile } from './utils.js';
import { toSlashCommandInfo, type SlashCommandInfo } from '../../src/shared/slash-commands.js';

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  variant?: string;
  agent?: string;
  model?: { providerID?: string; modelID: string };
  system?: string;
  tools?: Record<string, boolean>;
  snapshotInitialization?: 'wait';
  directory?: string;
  signal?: AbortSignal;
};

/**
 * The wrapper's unified kilo client interface.
 * All wrapper modules depend on this type rather than the raw SDK client.
 */
export type WrapperKiloClient = {
  createSession: (opts?: { title?: string }) => Promise<{ id: string }>;
  getSession: (sessionId: string) => Promise<{ id: string }>;
  getSessionDetails: (
    sessionId: string,
    directory: string,
    signal?: AbortSignal
  ) => Promise<{ id: string; directory: string }>;
  ensureSession: (sessionId: string, directory: string, signal?: AbortSignal) => Promise<void>;
  sendPrompt: (opts: PromptOptions) => Promise<SessionPromptResponse>;
  sendPromptAsync: (opts: PromptOptions) => Promise<void>;
  abortSession: (opts: {
    sessionId: string;
    directory?: string;
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
    snapshotInitialization?: 'wait';
    directory?: string;
    signal?: AbortSignal;
  }) => Promise<SessionCommandResponse>;
  /** Fetch the full slash command catalog from kilo, trimmed to wire shape. */
  listCommands: () => Promise<SlashCommandInfo[]>;
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

  /**
   * Subscribe to kilo events. The stream yields typed events until the abort
   * signal fires or the server closes the stream. Used by connection.ts.
   */
  subscribeEvents: (opts: { signal?: AbortSignal }) => Promise<{
    stream?: AsyncIterable<KiloEvent>;
  }>;
  /** The in-process server URL — for diagnostics */
  readonly serverUrl: string;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createWrapperKiloClient(
  sdkClient: SDKClient,
  serverUrl: string,
  workspacePath: string
): WrapperKiloClient {
  logToFile(`creating wrapper kilo client for ${serverUrl}`);
  const v2Client = createV2Client({ baseUrl: serverUrl, directory: workspacePath });

  function promptParameters(opts: PromptOptions) {
    const rawParts =
      opts.parts ?? (opts.prompt ? [{ type: 'text' as const, text: opts.prompt }] : []);
    return {
      sessionID: opts.sessionId,
      directory: opts.directory ?? workspacePath,
      messageID: opts.messageId,
      parts: rawParts.map(part =>
        part.type === 'file'
          ? {
              type: 'file' as const,
              mime: part.mime,
              url: part.url,
              ...(part.filename ? { filename: part.filename } : {}),
            }
          : { type: 'text' as const, text: part.text }
      ),
      ...(opts.variant ? { variant: opts.variant } : {}),
      ...(opts.model
        ? { model: { providerID: opts.model.providerID ?? 'kilo', modelID: opts.model.modelID } }
        : {}),
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.snapshotInitialization
        ? { snapshotInitialization: opts.snapshotInitialization }
        : {}),
    };
  }

  return {
    serverUrl,

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
      return { id: data.id, directory: data.directory };
    },

    ensureSession: async (sessionId, directory, signal) => {
      const lookupTimeout = AbortSignal.timeout(5_000);
      const lookupSignal = signal ? AbortSignal.any([signal, lookupTimeout]) : lookupTimeout;
      const existing = await v2Client.session.get(
        { sessionID: sessionId, directory },
        { signal: lookupSignal }
      );
      if (existing.response?.status !== 404) {
        const data = requireSdkData(existing, `Session get for ${sessionId}`);
        if (data.id !== sessionId) {
          throw new Error(`Session get for ${sessionId} returned an invalid session`);
        }
        return;
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
      const imported = await v2Client.kilocode.sessionImport.session(
        {
          query_directory: directory,
          body_directory: directory,
          id: sessionId,
          projectID: project.id,
          slug: sessionId.slice(0, 24),
          title: 'New session - ' + new Date(now).toISOString(),
          version: '7.4.20',
          timeCreated: now,
          timeUpdated: now,
        },
        { signal: signal ? AbortSignal.any([signal, importTimeout]) : importTimeout }
      );
      const data = requireSdkData(imported, `Session import for ${sessionId}`);
      if (!data.ok || data.id !== sessionId) {
        throw new Error(`Session import for ${sessionId} returned an invalid session`);
      }
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
        { sessionID: opts.sessionId, directory: opts.directory ?? workspacePath },
        { signal: opts.signal }
      );
      const operation = `Session abort for ${opts.sessionId}`;
      const data = requireSdkData<unknown>(result, operation);
      if (typeof data !== 'boolean') {
        throw new Error(`${operation} returned no boolean result`);
      }
      return data;
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
          ...(opts.snapshotInitialization
            ? { snapshotInitialization: opts.snapshotInitialization }
            : {}),
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
        if (trimmed && trimmed.source !== 'skill') commands.push(trimmed);
      }
      return commands;
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
  };
}
