import fs from 'node:fs';
import path from 'node:path';
import {
  sessionOperationResultHash,
  type SessionOperationAuthorization,
  type SessionOperationDelivery,
  type SessionOperationAck,
} from '../../../src/shared/sandbox-control-protocol';
import type { WrapperKiloClient } from '../kilo-api';
import { applySessionAttach } from './apply-attach';
import { createControlHandlerDeps, type HandlerDeps } from './sandbox-control-handlers';
import {
  buildWorktreeKiloEnvironment,
  type WorktreeKiloAuth,
  type WorktreeKiloRuntime,
} from './worktree-runtime';

export const session = {
  sessionId: 'ses_1',
  kiloSessionId: 'kilo_1',
  directory: '/workspace',
};

export type Completion = Awaited<ReturnType<WrapperKiloClient['sendPrompt']>>;

export function completion(error?: Completion['info']['error']): Completion {
  return {
    info: {
      id: 'assistant_1',
      sessionID: session.kiloSessionId,
      parentID: 'msg_1',
      role: 'assistant',
      time: { created: 1, completed: 2 },
      modelID: 'kilo/example',
      providerID: 'kilo',
      mode: 'code',
      agent: 'code',
      path: { cwd: session.directory, root: session.directory },
      cost: 0,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      ...(error ? { error } : {}),
    },
    parts: [],
  };
}

export function fakeKilo(overrides: Partial<WrapperKiloClient> = {}): WrapperKiloClient {
  return {
    getSession: async (id: string) => ({ id }),
    ensureSession: async () => undefined,
    sendPrompt: async () => completion(),
    sendPromptAsync: async () => {},
    sendCommand: async () => completion(),
    summarizeSession: async () => true,
    generateCommitMessage: async () => ({ message: 'Apply normal control turn' }),
    abortSession: async () => true,
    answerPermission: async () => true,
    answerQuestion: async () => true,
    rejectQuestion: async () => true,
    getSessionDetails: async (id: string, directory = session.directory) => ({ id, directory }),
    getSessionStatuses: async () => ({ [session.kiloSessionId]: { type: 'idle' } }),
    getQuestions: async () => [],
    getPermissions: async () => [],
    ...overrides,
  } as WrapperKiloClient;
}

export const kilo: WorktreeKiloAuth = {
  scopeId: 'worktree_1',
  token: 'guest-kilo-token',
  targets: {
    backendBaseUrl: 'https://backend.example.test',
    providerBaseUrl: 'https://provider.example.test',
    sessionIngestBaseUrl: 'https://ingest.example.test',
  },
};

export const promptPayload = {
  messageId: 'msg_1',
  turn: { type: 'prompt', prompt: 'hello' },
  agent: { mode: 'architect', model: 'kilo/example', variant: 'high' },
} as const;

export function createHandlerFixture(
  homeRoot: string,
  overrides: Partial<Omit<HandlerDeps, 'operations'>> & { kiloClient?: WrapperKiloClient } = {},
  identity = session
): HandlerDeps {
  const { kiloClient, ...rest } = overrides;
  const client = Object.hasOwn(overrides, 'kiloClient') ? kiloClient : fakeKilo();
  const nativeLifetime = new AbortController();
  const runtime: WorktreeKiloRuntime | undefined = client
    ? {
        scopeId: kilo.scopeId,
        runtimeId: 'native_1',
        directory: identity.directory,
        env: buildWorktreeKiloEnvironment(
          identity.directory,
          fs.mkdtempSync(path.join(homeRoot, 'worktree-')),
          kilo,
          {},
          {}
        ),
        kiloClient: client,
        signal: nativeLifetime.signal,
      }
    : undefined;
  return createControlHandlerDeps({
    kiloRuntimes: runtime
      ? {
          attach: () => {
            nativeLifetime.signal.throwIfAborted();
            return {
              ready: Promise.resolve(runtime),
              signal: runtime.signal,
              cleanup: async () => 'retired',
              commit: () => {},
              release: () => {},
            };
          },
          detach: () => true,
          deleteDirectory: async () => {},
          getRetained: directory => (directory === runtime.directory ? runtime : undefined),
          retireRuntime: async (directory, _deadlineAt, target) => {
            if (
              directory !== runtime.directory ||
              !target ||
              target.runtimeId !== runtime.runtimeId ||
              target.client !== runtime.kiloClient
            )
              return 'stale';
            nativeLifetime.abort();
            return 'retired';
          },
          verifyQuiescence: async (directory, target, deadlineAt) =>
            directory === runtime.directory &&
            target.client === runtime.kiloClient &&
            !nativeLifetime.signal.aborted &&
            Date.now() < deadlineAt,
          get: directory =>
            directory === runtime.directory && !nativeLifetime.signal.aborted ? runtime : undefined,
          isHealthy: () => true,
          shutdown: () => {},
        }
      : undefined,
    version: '2.4.0',
    kiloReady: true,
    sessions: [],
    emitSessionEvent: () => {},
    retireRuntime: () => {},
    applyAttach: (session, payload, deps) =>
      applySessionAttach(session, payload, { ...deps, sessionExists: async () => true }),
    ...rest,
  });
}

export function operationAuthorization(
  operation: SessionOperationAuthorization['operation'] = 'session.prompt',
  messageId = 'msg_1',
  identity = session
): SessionOperationAuthorization {
  return {
    operation,
    operationId: operation === 'session.prompt' ? messageId : `prepare_${messageId}`,
    messageId,
    session: { ...identity },
    wrapperInstanceId: crypto.randomUUID(),
    dispatchDeadlineAt: Date.now() + 60_000,
  };
}

export async function acknowledgeOperation(
  delivery: SessionOperationDelivery
): Promise<SessionOperationAck> {
  return {
    version: 2,
    authorization: delivery.authorization,
    resultHash: await sessionOperationResultHash(delivery),
    disposition: 'applied',
    decision: { state: delivery.outcome?.status ?? 'queued', at: delivery.completedAt },
  };
}
