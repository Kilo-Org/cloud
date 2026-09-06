import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  sessionSyncResultSchema,
  type SessionEventPayload,
  type SessionGitSummaryResult,
} from '../../../src/shared/sandbox-control-protocol';
import { createWrapperKiloClient, type WrapperKiloClient, type WrapperPty } from '../kilo-api';
import { materializeMessageAttachments } from '../session-bootstrap';
import { runProcess, withTimeoutAndAbort } from '../utils';
import { applySessionAttach } from './apply-attach';
import { updateSessionSnapshots, unfilteredKiloEvents } from './feed';
import {
  forgetAttachedRoot,
  rememberAttachedRoot,
  rememberChildSession,
  rememberSessionDirectory,
  resetSessionDirectoryState,
} from './session-directories';
import { CONTROL_RUNTIME_RESERVED_ENV_VARS } from '../../../src/shared/runtime-environment.js';
import {
  buildHeartbeatPayload,
  cancelControlTasks,
  createSessionActivityRegistry,
  handleControlRequest,
  refreshHeartbeatPayload,
  type HandlerDeps,
} from './sandbox-control-handlers';
import {
  assertDirectoryActive,
  fenceDirectoryOperations,
  resetDirectoryOperationState,
} from './worktree-operations';
import { KILO_CONTROL_REQUEST_TIMEOUT_MS } from './sandbox-control-runtime';
import {
  ControlTerminalRuntimeError,
  createControlTerminalRuntime,
  type ControlTerminalRuntime,
} from './terminal-runtime';
import { directoryForSession, rootForSession } from './session-directories';
import {
  buildWorktreeKiloEnvironment,
  type WorktreeKiloAuth,
  type WorktreeKiloRuntime,
} from './worktree-runtime';

const session = {
  sessionId: 'ses_1',
  kiloSessionId: 'kilo_1',
  directory: '/workspace',
};

type Completion = Awaited<ReturnType<WrapperKiloClient['sendPrompt']>>;

function completion(error?: Completion['info']['error']): Completion {
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

function fakeKilo(overrides: Partial<WrapperKiloClient> = {}): WrapperKiloClient {
  return {
    getSession: async id => ({ id }),
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
    getSessionStatuses: async () => ({}),
    getQuestions: async () => [],
    getPermissions: async () => [],
    ...overrides,
  } as WrapperKiloClient;
}

const kilo: WorktreeKiloAuth = {
  scopeId: 'worktree_1',
  token: 'guest-kilo-token',
  targets: {
    backendBaseUrl: 'https://backend.example.test',
    providerBaseUrl: 'https://provider.example.test',
    sessionIngestBaseUrl: 'https://ingest.example.test',
  },
};

let homeRoot: string;

function deps(
  overrides: Partial<HandlerDeps> & { kiloClient?: WrapperKiloClient } = {},
  identity = session
): HandlerDeps {
  const { kiloClient, ...rest } = overrides;
  const client = Object.hasOwn(overrides, 'kiloClient') ? kiloClient : fakeKilo();
  const runtime: WorktreeKiloRuntime | undefined = client
    ? {
        scopeId: kilo.scopeId,
        directory: identity.directory,
        env: buildWorktreeKiloEnvironment(
          identity.directory,
          fs.mkdtempSync(path.join(homeRoot, 'worktree-')),
          kilo,
          {},
          {}
        ),
        kiloClient: client,
        signal: new AbortController().signal,
      }
    : undefined;
  return {
    kiloRuntimes: runtime
      ? ({
          attach: () => ({
            ready: Promise.resolve(runtime),
            signal: runtime.signal,
            commit: () => {},
            release: () => {},
          }),
          detach: () => true,
          deleteDirectory: async () => {},
          get: directory => (directory === runtime.directory ? runtime : undefined),
          isHealthy: () => true,
          shutdown: () => {},
        } as NonNullable<HandlerDeps['kiloRuntimes']>)
      : undefined,
    version: '2.4.0',
    kiloReady: true,
    sessions: [],
    tasks: new Map(),
    emitSessionEvent: () => {},
    retireRuntime: () => {},
    applyAttach: (session, payload, deps) =>
      applySessionAttach(session, payload, { ...deps, sessionExists: async () => true }),
    ...rest,
  };
}

function runtimeDeps(kiloClient: WrapperKiloClient) {
  const abort = new AbortController();
  const events: SessionEventPayload[] = [];
  const retired: string[] = [];
  let shuttingDown = false;
  const handlerDeps: HandlerDeps = {
    ...deps({ kiloClient }),
    get kiloReady() {
      return !shuttingDown;
    },
    signal: abort.signal,
    emitSessionEvent: (_session, event) => events.push(event),
    retireRuntime: reason => {
      if (shuttingDown) return;
      shuttingDown = true;
      retired.push(reason);
      void cancelControlTasks(handlerDeps, reason, 'failed');
      abort.abort();
    },
  };
  return { handlerDeps, events, retired };
}

async function waitForTasks(handlerDeps: HandlerDeps): Promise<void> {
  await Promise.all([...handlerDeps.tasks.values()].map(task => task.done));
}

const promptPayload = {
  messageId: 'msg_1',
  turn: { type: 'prompt', prompt: 'hello' },
  agent: { mode: 'architect', model: 'kilo/example', variant: 'high' },
} as const;

beforeEach(() => {
  resetSessionDirectoryState();
  resetDirectoryOperationState();
  rememberAttachedRoot(session.kiloSessionId, session.directory);
  homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'control-handlers-test-'));
});

afterEach(() => {
  setSystemTime();
  fs.rmSync(homeRoot, { recursive: true, force: true });
});

const pty: WrapperPty = {
  id: 'pty_1',
  title: 'Workspace terminal',
  command: '/bin/bash',
  args: [],
  cwd: session.directory,
  status: 'running',
  pid: 17,
};

function fakeTerminalRuntime(
  overrides: Partial<ControlTerminalRuntime> = {}
): ControlTerminalRuntime {
  return {
    rememberAttachedSession: () => {},
    detachSession: async () => {},
    detachDirectory: async () => {},
    create: async () => ({ pty }),
    resize: async () => ({ pty }),
    close: async () => ({ success: true }),
    connect: async () => ({ connected: true }),
    shutdown: () => {},
    ...overrides,
  };
}

describe('handleControlRequest', () => {
  it('returns sandbox.status from deps', async () => {
    const result = await handleControlRequest('sandbox.status', undefined, {}, deps());
    expect(result).toEqual({
      ok: true,
      result: {
        healthy: true,
        state: 'idle',
        version: '2.4.0',
        kiloReady: true,
      },
    });
  });

  it('calls the completion-returning prompt API with the owned message and directory', async () => {
    const calls: unknown[] = [];
    const events: SessionEventPayload[] = [];
    const kiloClient = fakeKilo({
      sendPrompt: async opts => {
        calls.push(opts);
        return completion();
      },
    });
    const handlerDeps = deps({
      kiloClient,
      emitSessionEvent: (_session, event) => events.push(event),
    });

    const result = await handleControlRequest(
      'session.prompt',
      session,
      promptPayload,
      handlerDeps
    );
    expect(result).toEqual({ ok: true, result: { messageId: 'msg_1', status: 'accepted' } });
    await waitForTasks(handlerDeps);
    expect(calls).toEqual([
      {
        sessionId: 'kilo_1',
        directory: session.directory,
        signal: expect.any(AbortSignal),
        messageId: 'msg_1',
        prompt: 'hello',
        agent: 'architect',
        model: { providerID: 'kilo', modelID: 'kilo/example' },
        variant: 'high',
      },
    ]);
    expect(events).toEqual([
      { type: 'session.message.outcome', properties: { messageId: 'msg_1', status: 'completed' } },
    ]);
  });

  it('calls sendCommand with the structured command and messageId', async () => {
    const commands: unknown[] = [];
    const prompts: unknown[] = [];
    const kiloClient = fakeKilo({
      sendCommand: async opts => {
        commands.push(opts);
        return completion();
      },
      sendPrompt: async opts => {
        prompts.push(opts);
        return completion();
      },
    });

    const result = await handleControlRequest(
      'session.prompt',
      session,
      {
        messageId: 'msg_command',
        turn: { type: 'command', command: 'review', arguments: '--all changes' },
        agent: { mode: 'architect', model: 'kilo/example', variant: 'high' },
      },
      deps({ kiloClient })
    );

    expect(result).toEqual({ ok: true, result: { messageId: 'msg_command', status: 'accepted' } });
    expect(commands).toEqual([
      {
        sessionId: 'kilo_1',
        directory: session.directory,
        signal: expect.any(AbortSignal),
        command: 'review',
        args: '--all changes',
        messageId: 'msg_command',
        agent: 'architect',
        model: { providerID: 'kilo', modelID: 'kilo/example' },
        variant: 'high',
      },
    ]);
    expect(prompts).toEqual([]);
  });

  it('preserves command model omission with agent and variant', async () => {
    const commands: unknown[] = [];
    const kiloClient = fakeKilo({
      sendCommand: async opts => {
        commands.push(opts);
        return completion();
      },
    });

    const result = await handleControlRequest(
      'session.prompt',
      session,
      {
        messageId: 'msg_command',
        turn: { type: 'command', command: 'review', arguments: '' },
        agent: { mode: 'reviewer', variant: 'high' },
      },
      deps({ kiloClient })
    );

    expect(result).toEqual({
      ok: true,
      result: { messageId: 'msg_command', status: 'accepted' },
    });
    expect(commands).toEqual([
      {
        sessionId: 'kilo_1',
        directory: session.directory,
        signal: expect.any(AbortSignal),
        command: 'review',
        args: '',
        messageId: 'msg_command',
        agent: 'reviewer',
        variant: 'high',
      },
    ]);
  });

  it('rejects a missing prompt model before calling Kilo', async () => {
    const calls: unknown[] = [];
    const kiloClient = fakeKilo({
      sendPrompt: async opts => {
        calls.push(opts);
        return completion();
      },
      sendCommand: async opts => {
        calls.push(opts);
        return completion();
      },
    });

    const result = await handleControlRequest(
      'session.prompt',
      session,
      {
        messageId: 'msg_1',
        turn: { type: 'prompt', prompt: 'hello' },
        agent: { mode: 'code' },
      },
      deps({ kiloClient })
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'Invalid payload', retryable: false },
    });
    expect(calls).toEqual([]);
  });

  it('returns protocol_error for session.prompt without session', async () => {
    const result = await handleControlRequest(
      'session.prompt',
      undefined,
      {
        messageId: 'msg_1',
        turn: { type: 'prompt', prompt: 'hello' },
        agent: { mode: 'code', model: 'kilo-model' },
      },
      deps()
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'session identity is required', retryable: false },
    });
  });

  it('attaches by verifying the kilo session', async () => {
    const result = await handleControlRequest('session.attach', session, { kilo }, deps());
    expect(result).toEqual({ ok: true, result: { attached: true } });
  });

  it('registers terminal eligibility only after successful session attachment', async () => {
    const attached: unknown[] = [];
    const terminalRuntime = fakeTerminalRuntime({
      rememberAttachedSession: identity => attached.push(identity),
    });

    const request = handleControlRequest(
      'session.attach',
      session,
      { kilo },
      deps({ terminalRuntime })
    );
    expect(attached).toEqual([]);

    expect(await request).toEqual({ ok: true, result: { attached: true } });
    expect(attached).toEqual([session]);

    const failed = await handleControlRequest(
      'session.attach',
      { ...session, sessionId: 'ses_missing', kiloSessionId: 'kilo_missing' },
      { kilo },
      deps({ kiloClient: undefined, terminalRuntime })
    );
    expect(failed.ok).toBe(false);
    expect(attached).toEqual([session]);
  });

  it('keeps mismatched attachment roots ineligible without breaking chat attachment', async () => {
    const attached: unknown[] = [];
    const terminalRuntime = fakeTerminalRuntime({
      rememberAttachedSession: identity => attached.push(identity),
    });

    const result = await handleControlRequest(
      'session.attach',
      session,
      { kilo, snapshotIdentity: 'kilo_other' },
      deps({ terminalRuntime })
    );

    expect(result).toEqual({ ok: true, result: { attached: true } });
    expect(attached).toEqual([]);
  });

  it('rejects mismatched attachment directories before registering a chat or terminal', async () => {
    resetSessionDirectoryState();
    const activity = createSessionActivityRegistry();
    const attached: unknown[] = [];
    const terminalRuntime = fakeTerminalRuntime({
      rememberAttachedSession: identity => attached.push(identity),
    });

    const result = await handleControlRequest(
      'session.attach',
      session,
      { kilo, directory: '/workspace/different' },
      deps({ terminalRuntime, activity })
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'Attachment directory mismatch', retryable: false },
    });
    expect(attached).toEqual([]);
    expect(activity.snapshots()).toEqual([]);
    expect(rootForSession(session.kiloSessionId)).toBeUndefined();
  });

  it('registers each successful attach as an independently idle root', async () => {
    let now = 100;
    const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
    const activity = createSessionActivityRegistry(() => now);
    const handlerDeps = deps({ activity });

    expect(await handleControlRequest('session.attach', session, { kilo }, handlerDeps)).toEqual({
      ok: true,
      result: { attached: true },
    });
    now = 150;
    expect(await handleControlRequest('session.attach', sibling, { kilo }, handlerDeps)).toEqual({
      ok: true,
      result: { attached: true },
    });
    expect(activity.snapshots()).toEqual([
      { kiloSessionId: 'kilo_1', state: 'idle', idleForMs: 50 },
      { kiloSessionId: 'kilo_2', state: 'idle', idleForMs: 0 },
    ]);
  });

  it('does not register failed attachments as advisory roots', async () => {
    resetSessionDirectoryState();
    const activity = createSessionActivityRegistry(() => 100);
    const handlerDeps = deps({
      activity,
      applyAttach: async () => {
        throw new Error('Session restoration failed');
      },
    });

    expect(
      await handleControlRequest('session.attach', session, { kilo }, handlerDeps)
    ).toMatchObject({ ok: false });
    expect(activity.snapshots()).toEqual([]);
    expect(rootForSession(session.kiloSessionId)).toBeUndefined();
    expect(handlerDeps.tasks.size).toBe(0);
  });

  it('marks only accepted root work active and leaves rejected sibling prompts idle', async () => {
    const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
    const finished = Promise.withResolvers<Completion>();
    const events: SessionEventPayload[] = [];
    const activity = createSessionActivityRegistry(() => 100);
    const handlerDeps = deps({
      activity,
      kiloClient: fakeKilo({ sendPrompt: () => finished.promise }),
      emitSessionEvent: (_identity, event) => events.push(event),
    });
    await handleControlRequest('session.attach', session, { kilo }, handlerDeps);
    await handleControlRequest('session.attach', sibling, { kilo }, handlerDeps);
    try {
      expect(
        await handleControlRequest('session.prompt', session, promptPayload, handlerDeps)
      ).toEqual({ ok: true, result: { messageId: 'msg_1', status: 'accepted' } });
      expect(
        await handleControlRequest(
          'session.prompt',
          sibling,
          { ...promptPayload, messageId: 'msg_2', agent: { mode: 'code' } },
          handlerDeps
        )
      ).toEqual({
        ok: false,
        error: { code: 'protocol_error', message: 'Invalid payload', retryable: false },
      });
      expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({
        state: 'active',
        pendingMessages: 1,
        sessions: [
          { kiloSessionId: 'kilo_1', state: 'active', waitingOn: 'model' },
          { kiloSessionId: 'kilo_2', state: 'idle' },
        ],
      });
      expect(events).toEqual([]);
      finished.resolve(completion());
      await waitForTasks(handlerDeps);
      expect(events).toEqual([
        {
          type: 'session.message.outcome',
          properties: { messageId: 'msg_1', status: 'completed' },
        },
      ]);
      expect(buildHeartbeatPayload(handlerDeps).pendingMessages).toBe(0);
    } finally {
      finished.resolve(completion());
      await waitForTasks(handlerDeps);
    }
  });

  it('rejects reserved control environment values before attachment starts', async () => {
    let kiloRequests = 0;
    const kiloClient = fakeKilo({
      getSession: async id => {
        kiloRequests += 1;
        return { id };
      },
    });

    for (const name of CONTROL_RUNTIME_RESERVED_ENV_VARS) {
      const result = await handleControlRequest(
        'session.attach',
        session,
        { env: { [name]: 'sensitive-value' } },
        deps({ kiloClient })
      );
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'protocol_error',
          message: 'Reserved control runtime environment variable',
          retryable: false,
        },
      });
    }

    expect(kiloRequests).toBe(0);
  });

  it('resolves a pending permission', async () => {
    const answered: unknown[] = [];
    const kiloClient = fakeKilo({
      getPermissions: async () => [
        {
          id: 'perm_1',
          sessionID: session.kiloSessionId,
          permission: 'bash',
          patterns: [],
          metadata: {},
          always: [],
        },
      ],
      answerPermission: async (permissionId, response) => {
        answered.push({ permissionId, response });
        return true;
      },
    });

    const result = await handleControlRequest(
      'session.permission.resolve',
      session,
      { permissionId: 'perm_1', response: 'once' },
      deps({ kiloClient })
    );
    expect(result).toEqual({ ok: true, result: { success: true } });
    expect(answered).toEqual([{ permissionId: 'perm_1', response: 'once' }]);
  });

  it('does not send an unfenced abort when the wrapper owns no work', async () => {
    const aborted: string[] = [];
    const kiloClient = fakeKilo({
      abortSession: async opts => {
        aborted.push(opts.sessionId);
        return true;
      },
    });

    const result = await handleControlRequest('session.abort', session, {}, deps({ kiloClient }));
    expect(result).toEqual({ ok: true, result: { status: 'already_idle' } });
    expect(aborted).toEqual([]);
  });

  it('routes independent roots and their children through the matching worktree client', async () => {
    const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
    const other = { sessionId: 'ses_3', kiloSessionId: 'kilo_3', directory: '/workspace/other' };
    const child = { ...session, kiloSessionId: 'kilo_child' };
    rememberAttachedRoot(sibling.kiloSessionId, sibling.directory);
    rememberAttachedRoot(other.kiloSessionId, other.directory);
    rememberChildSession({
      childId: child.kiloSessionId,
      parentId: session.kiloSessionId,
      directory: session.directory,
    });
    const calls: Array<{ directory: string; operation: string; value: unknown }> = [];
    const pendingCommands = new Map<
      string,
      { started: PromiseWithResolvers<void>; completion: PromiseWithResolvers<Completion> }
    >();
    const runtimes = new Map<string, WorktreeKiloRuntime>();
    for (const directory of [session.directory, other.directory]) {
      const record = (operation: string, value: unknown) => {
        calls.push({ directory, operation, value });
      };
      const kiloClient = fakeKilo({
        sendPrompt: async value => {
          record('prompt', value);
          return completion();
        },
        sendCommand: async value => {
          record('command', value);
          const pending = pendingCommands.get(value.messageId ?? '');
          if (pending) {
            pending.started.resolve();
            return pending.completion.promise;
          }
          return completion();
        },
        abortSession: async value => {
          record('abort', value);
          return true;
        },
        answerPermission: async (...value) => {
          record('permission', value);
          return true;
        },
        answerQuestion: async (...value) => {
          record('question', value);
          return true;
        },
        rejectQuestion: async (...value) => {
          record('reject', value);
          return true;
        },
        getSessionStatuses: async () => {
          record('status', undefined);
          return {};
        },
        getPermissions: async () => {
          record('permissions', undefined);
          return [session, sibling, other, child].map(identity => ({
            id: `permission_${identity.kiloSessionId}`,
            sessionID: identity.kiloSessionId,
            permission: 'bash',
            patterns: [],
            metadata: {},
            always: [],
          }));
        },
        getQuestions: async () => {
          record('questions', undefined);
          return [session, sibling, other, child].map(identity => ({
            id: `question_${identity.kiloSessionId}`,
            sessionID: identity.kiloSessionId,
            questions: [],
          }));
        },
      });
      runtimes.set(directory, {
        directory,
        scopeId: directory,
        env: buildWorktreeKiloEnvironment(
          directory,
          fs.mkdtempSync(path.join(homeRoot, 'worktree-')),
          kilo,
          {},
          {}
        ),
        signal: new AbortController().signal,
        kiloClient,
      });
    }
    const handlerDeps = deps({
      kiloRuntimes: {
        attach: () => {
          throw new Error('Unexpected startup');
        },
        detach: () => true,
        deleteDirectory: async () => {},
        get: directory => runtimes.get(directory),
        isHealthy: () => true,
        shutdown: () => {},
      } as NonNullable<HandlerDeps['kiloRuntimes']>,
    });

    for (const identity of [session, sibling, other]) {
      const start = calls.length;
      const messageId = `msg_${identity.kiloSessionId}`;
      const prompt = {
        messageId,
        turn: { type: 'prompt', prompt: 'hello' },
        agent: { mode: 'code', model: 'model' },
      };
      expect(await handleControlRequest('session.prompt', identity, prompt, handlerDeps)).toEqual({
        ok: true,
        result: { messageId, status: 'accepted' },
      });
      await waitForTasks(handlerDeps);
      const commandId = `command_${identity.kiloSessionId}`;
      expect(
        await handleControlRequest(
          'session.prompt',
          identity,
          {
            ...prompt,
            messageId: commandId,
            turn: { type: 'command', command: 'review', arguments: '--all' },
          },
          handlerDeps
        )
      ).toEqual({ ok: true, result: { messageId: commandId, status: 'accepted' } });
      await waitForTasks(handlerDeps);
      const owned = identity === session ? [identity, child] : [identity];
      for (const asking of owned) {
        expect(
          await handleControlRequest(
            'session.permission.resolve',
            identity,
            { permissionId: `permission_${asking.kiloSessionId}`, response: 'once' },
            handlerDeps
          )
        ).toEqual({ ok: true, result: { success: true } });
        expect(
          await handleControlRequest(
            'session.question.resolve',
            identity,
            {
              action: 'answer',
              questionId: `question_${asking.kiloSessionId}`,
              answers: [['answer']],
            },
            handlerDeps
          )
        ).toEqual({ ok: true, result: { success: true } });
        expect(
          await handleControlRequest(
            'session.question.resolve',
            identity,
            { action: 'reject', questionId: `question_${asking.kiloSessionId}` },
            handlerDeps
          )
        ).toEqual({ ok: true, result: { success: true } });
      }
      expect(await handleControlRequest('session.abort', identity, {}, handlerDeps)).toEqual({
        ok: true,
        result: { status: 'already_idle' },
      });
      expect(await handleControlRequest('session.sync', identity, {}, handlerDeps)).toEqual({
        ok: true,
        result: {
          status: { type: 'idle' },
          questions: owned.map(asking => ({
            id: `question_${asking.kiloSessionId}`,
            sessionID: asking.kiloSessionId,
            questions: [],
            ...(asking === child ? { rootKiloSessionId: identity.kiloSessionId } : {}),
          })),
          permissions: owned.map(asking => ({
            id: `permission_${asking.kiloSessionId}`,
            sessionID: asking.kiloSessionId,
            permission: 'bash',
            patterns: [],
            metadata: {},
            always: [],
            ...(asking === child ? { rootKiloSessionId: identity.kiloSessionId } : {}),
          })),
        },
      });
      expect(calls.slice(start).every(call => call.directory === identity.directory)).toBe(true);
      expect(calls[start]?.value).toEqual({
        sessionId: identity.kiloSessionId,
        directory: identity.directory,
        signal: expect.any(AbortSignal),
        messageId,
        prompt: 'hello',
        agent: 'code',
        model: { providerID: 'kilo', modelID: 'model' },
      });
      expect(calls[start + 1]?.value).toEqual({
        sessionId: identity.kiloSessionId,
        directory: identity.directory,
        signal: expect.any(AbortSignal),
        messageId: commandId,
        command: 'review',
        args: '--all',
        agent: 'code',
        model: { providerID: 'kilo', modelID: 'model' },
      });
      expect(calls.slice(start).map(call => call.operation)).toEqual([
        'prompt',
        'command',
        ...owned.flatMap(() => [
          'permissions',
          'permission',
          'questions',
          'question',
          'questions',
          'reject',
        ]),
        'status',
        'questions',
        'permissions',
      ]);
      for (const asking of owned) {
        expect(calls.slice(start)).toContainEqual({
          directory: identity.directory,
          operation: 'permission',
          value: [
            `permission_${asking.kiloSessionId}`,
            'once',
            undefined,
            true,
            asking.directory,
            expect.any(AbortSignal),
          ],
        });
        expect(calls.slice(start)).toContainEqual({
          directory: identity.directory,
          operation: 'question',
          value: [
            `question_${asking.kiloSessionId}`,
            [['answer']],
            asking.directory,
            expect.any(AbortSignal),
          ],
        });
        expect(calls.slice(start)).toContainEqual({
          directory: identity.directory,
          operation: 'reject',
          value: [`question_${asking.kiloSessionId}`, asking.directory, expect.any(AbortSignal)],
        });
      }
      const cancellingId = `cancel_${identity.kiloSessionId}`;
      const pending = {
        started: Promise.withResolvers<void>(),
        completion: Promise.withResolvers<Completion>(),
      };
      pendingCommands.set(cancellingId, pending);
      try {
        expect(
          await handleControlRequest(
            'session.prompt',
            identity,
            {
              ...prompt,
              messageId: cancellingId,
              turn: { type: 'command', command: 'review', arguments: '--all' },
            },
            handlerDeps
          )
        ).toEqual({ ok: true, result: { messageId: cancellingId, status: 'accepted' } });
        await pending.started.promise;
        expect(
          await handleControlRequest(
            'session.abort',
            identity,
            { messageId: cancellingId },
            handlerDeps
          )
        ).toEqual({
          ok: true,
          result: { status: 'aborted' },
        });
        expect(calls.at(-1)).toEqual({
          directory: identity.directory,
          operation: 'abort',
          value: {
            sessionId: identity.kiloSessionId,
            directory: identity.directory,
            signal: expect.any(AbortSignal),
          },
        });
        expect(handlerDeps.tasks.has(identity.kiloSessionId)).toBe(false);
      } finally {
        pending.completion.resolve(completion());
        await waitForTasks(handlerDeps);
        pendingCommands.delete(cancellingId);
      }
    }

    const before = calls.length;
    expect(
      (await handleControlRequest('session.prompt', child, promptPayload, handlerDeps)).ok
    ).toBe(false);
    const wrongDirectory = await handleControlRequest(
      'session.prompt',
      { ...session, directory: other.directory },
      promptPayload,
      handlerDeps
    );
    expect(wrongDirectory.ok).toBe(false);
    expect(calls).toHaveLength(before);
  });

  it('detaches only the targeted root, its child mappings, and its activity', async () => {
    const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
    const activity = createSessionActivityRegistry(() => 100);
    rememberAttachedRoot(sibling.kiloSessionId, sibling.directory);
    rememberChildSession({ childId: 'child_1', parentId: 'kilo_1', directory: '/workspace' });
    rememberChildSession({ childId: 'child_2', parentId: 'kilo_2', directory: '/workspace' });
    activity.attach('kilo_1');
    activity.attach('kilo_2');
    activity.markActive('kilo_1');

    expect(await handleControlRequest('session.detach', sibling, {}, deps({ activity }))).toEqual({
      ok: true,
      result: { detached: true },
    });
    expect(activity.snapshots()).toEqual([
      { kiloSessionId: 'kilo_1', state: 'active', idleForMs: 0, waitingOn: 'model' },
    ]);
    expect(rootForSession('child_1', '/workspace')).toBe('kilo_1');
    expect(rootForSession('kilo_2', '/workspace')).toBeUndefined();
    expect(rootForSession('child_2', '/workspace')).toBeUndefined();
  });

  it('retains an attached root for retry until native cancellation is confirmed', async () => {
    const sibling = { ...session, sessionId: 'ses_sibling', kiloSessionId: 'kilo_sibling' };
    rememberAttachedRoot(sibling.kiloSessionId, sibling.directory);
    let confirmed = false;
    const handlerDeps = deps({ kiloClient: fakeKilo({ abortSession: async () => confirmed }) });
    const runtime = handlerDeps.kiloRuntimes?.get(session.directory);
    expect(handlerDeps.tasks.size).toBe(0);
    expect(await handleControlRequest('session.detach', session, {}, handlerDeps)).toMatchObject({
      ok: false,
      error: { code: 'not_ready' },
    });
    expect(rootForSession(session.kiloSessionId)).toBe(session.kiloSessionId);
    expect(rootForSession(sibling.kiloSessionId)).toBe(sibling.kiloSessionId);
    expect(handlerDeps.kiloRuntimes?.get(session.directory)).toBe(runtime);
    confirmed = true;
    expect(await handleControlRequest('session.detach', session, {}, handlerDeps)).toEqual({
      ok: true,
      result: { detached: true },
    });
    expect(rootForSession(session.kiloSessionId)).toBeUndefined();
    expect(rootForSession(sibling.kiloSessionId)).toBe(sibling.kiloSessionId);
  });

  it('preserves root lineage, sibling activity, tasks, and terminals when the detach directory does not match', async () => {
    const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
    const activity = createSessionActivityRegistry(() => 100);
    rememberAttachedRoot(sibling.kiloSessionId, sibling.directory);
    rememberChildSession({ childId: 'child_1', parentId: session.kiloSessionId });
    rememberChildSession({ childId: 'child_2', parentId: sibling.kiloSessionId });
    activity.attach(session.kiloSessionId);
    activity.attach(sibling.kiloSessionId);
    activity.markActive(session.kiloSessionId);
    const finished = Promise.withResolvers<Completion>();
    const started = Promise.withResolvers<void>();
    const mutations: string[] = [];
    const handlerDeps = deps({
      activity,
      kiloClient: fakeKilo({
        sendPrompt: () => {
          started.resolve();
          return finished.promise;
        },
        abortSession: async () => {
          mutations.push('abort');
          return true;
        },
      }),
      terminalRuntime: fakeTerminalRuntime({
        detachSession: async () => {
          mutations.push('terminal');
        },
      }),
      emitSessionEvent: () => mutations.push('outcome'),
    });
    const runtimes = handlerDeps.kiloRuntimes;
    if (!runtimes) throw new Error('Expected worktree runtimes');
    runtimes.detach = () => {
      mutations.push('runtime');
      return true;
    };
    try {
      await handleControlRequest('session.prompt', session, promptPayload, handlerDeps);
      await started.promise;
      const task = handlerDeps.tasks.get(session.kiloSessionId);
      const snapshots = [...handlerDeps.sessions];
      expect(
        await handleControlRequest(
          'session.detach',
          { ...session, directory: '/workspace/different' },
          {},
          handlerDeps
        )
      ).toEqual({
        ok: false,
        error: { code: 'unauthorized', message: 'Session directory mismatch', retryable: false },
      });
      expect(rootForSession(session.kiloSessionId)).toBe(session.kiloSessionId);
      expect(rootForSession('child_1')).toBe(session.kiloSessionId);
      expect(rootForSession('child_2')).toBe(sibling.kiloSessionId);
      expect(directoryForSession(session.kiloSessionId)).toBe(session.directory);
      expect(handlerDeps.tasks.get(session.kiloSessionId)).toBe(task);
      expect(task?.signal.aborted).toBe(false);
      expect(handlerDeps.sessions).toEqual(snapshots);
      expect(activity.snapshots()).toEqual([
        { kiloSessionId: session.kiloSessionId, state: 'active', idleForMs: 0, waitingOn: 'model' },
        { kiloSessionId: sibling.kiloSessionId, state: 'idle', idleForMs: 0 },
      ]);
      expect(mutations).toEqual([]);
    } finally {
      finished.resolve(completion());
      await waitForTasks(handlerDeps);
    }
  });

  it('aborts a native root without an owned task and detaches without stopping its sibling', async () => {
    const sibling = { ...session, sessionId: 'ses_sibling', kiloSessionId: 'kilo_sibling' };
    rememberAttachedRoot(sibling.kiloSessionId, sibling.directory);
    const started = Promise.withResolvers<void>();
    const running = Promise.withResolvers<Completion>();
    const events: SessionEventPayload[] = [];
    const aborted: string[] = [];
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        sendPrompt: () => {
          started.resolve();
          return running.promise;
        },
        abortSession: async options => {
          aborted.push(options.sessionId);
          return true;
        },
      }),
      emitSessionEvent: (_identity, event) => events.push(event),
    });
    let shutdowns = 0;
    const runtimes = handlerDeps.kiloRuntimes;
    if (!runtimes) throw new Error('Expected worktree runtime');
    runtimes.shutdown = () => {
      shutdowns += 1;
    };
    const runtime = runtimes.get(session.directory);
    expect(
      await handleControlRequest('session.prompt', sibling, promptPayload, handlerDeps)
    ).toEqual({
      ok: true,
      result: { messageId: promptPayload.messageId, status: 'accepted' },
    });
    await started.promise;
    expect(await handleControlRequest('session.detach', session, {}, handlerDeps)).toEqual({
      ok: true,
      result: { detached: true },
    });
    expect(shutdowns).toBe(0);
    expect(runtimes.get(session.directory)).toBe(runtime);
    expect(handlerDeps.tasks.get(sibling.kiloSessionId)?.signal.aborted).toBe(false);
    expect(events).toEqual([]);
    expect(aborted).toEqual([session.kiloSessionId]);
    expect(await handleControlRequest('session.abort', sibling, {}, handlerDeps)).toEqual({
      ok: true,
      result: { status: 'aborted' },
    });
    expect(aborted).toEqual([session.kiloSessionId, sibling.kiloSessionId]);
    expect(events).toEqual([
      {
        type: 'session.message.outcome',
        properties: {
          messageId: promptPayload.messageId,
          status: 'cancelled',
          reason: 'Session aborted',
        },
      },
    ]);
    running.resolve(completion());
    expect(
      (await handleControlRequest('session.prompt', session, promptPayload, handlerDeps)).ok
    ).toBe(false);
    await handleControlRequest('sandbox.shutdown', undefined, {}, handlerDeps);
    expect(shutdowns).toBe(1);
  });

  it('preserves reattached routing and terminal state after delayed detach cleanup', async () => {
    const deleting = Promise.withResolvers<void>();
    const releaseDelete = Promise.withResolvers<void>();
    let created = 0;
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        createPty: async () => ({ ...pty, id: `pty_${++created}` }),
        deletePty: async id => {
          if (id === 'pty_1') {
            deleting.resolve();
            await releaseDelete.promise;
          }
          return true;
        },
      }),
    });
    const runtimes = handlerDeps.kiloRuntimes;
    if (!runtimes) throw new Error('Expected worktree runtimes');
    const terminalRuntime = createControlTerminalRuntime({
      controlUrl: 'ws://127.0.0.1:1/sandbox-control/test',
      wrapperInstanceId: crypto.randomUUID(),
      getKiloRuntime: directory => runtimes.get(directory),
    });
    handlerDeps.terminalRuntime = terminalRuntime;
    const sibling = { ...session, sessionId: 'ses_sibling', kiloSessionId: 'kilo_sibling' };
    const operationId = crypto.randomUUID();
    let detachRequest: ReturnType<typeof handleControlRequest> | undefined;
    try {
      expect(
        (await handleControlRequest('session.attach', session, { kilo }, handlerDeps)).ok
      ).toBe(true);
      expect(
        (await handleControlRequest('session.attach', sibling, { kilo }, handlerDeps)).ok
      ).toBe(true);
      expect(
        (
          await handleControlRequest(
            'session.terminal.create',
            session,
            { operationId },
            handlerDeps
          )
        ).ok
      ).toBe(true);

      detachRequest = handleControlRequest('session.detach', session, {}, handlerDeps);
      await deleting.promise;
      expect(rootForSession(session.kiloSessionId)).toBeUndefined();
      expect(directoryForSession(session.kiloSessionId)).toBeUndefined();
      expect(handlerDeps.sessions).toEqual([
        { kiloSessionId: sibling.kiloSessionId, lastActivityAt: expect.any(Number) },
      ]);
      expect(rootForSession(sibling.kiloSessionId)).toBe(sibling.kiloSessionId);
      expect(
        (await handleControlRequest('session.attach', session, { kilo }, handlerDeps)).ok
      ).toBe(true);

      const replacement = await handleControlRequest(
        'session.terminal.create',
        session,
        { operationId },
        handlerDeps
      );
      expect(replacement).toMatchObject({ ok: true, result: { pty: { id: 'pty_2' } } });
      releaseDelete.resolve();
      expect(await detachRequest).toEqual({ ok: true, result: { detached: true } });
      expect(rootForSession(session.kiloSessionId)).toBe(session.kiloSessionId);
      expect(directoryForSession(session.kiloSessionId)).toBe(session.directory);
      expect(handlerDeps.sessions).toEqual([
        { kiloSessionId: sibling.kiloSessionId, lastActivityAt: expect.any(Number) },
        { kiloSessionId: session.kiloSessionId, lastActivityAt: expect.any(Number) },
      ]);
      expect(
        await handleControlRequest('session.terminal.create', session, { operationId }, handlerDeps)
      ).toEqual(replacement);
    } finally {
      releaseDelete.resolve();
      await detachRequest;
      terminalRuntime.shutdown();
    }
  });

  it('routes validated terminal lifecycle requests to the exact session', async () => {
    const calls: Array<{ operation: string; identity: unknown; payload: unknown }> = [];
    const terminalRuntime = fakeTerminalRuntime({
      create: async (identity, payload) => {
        calls.push({ operation: 'create', identity, payload });
        return { pty };
      },
      resize: async (identity, payload) => {
        calls.push({ operation: 'resize', identity, payload });
        return { pty };
      },
      close: async (identity, payload) => {
        calls.push({ operation: 'close', identity, payload });
        return { success: true };
      },
      connect: async (identity, payload) => {
        calls.push({ operation: 'connect', identity, payload });
        return { connected: true };
      },
    });
    const createPayload = {
      operationId: '00000000-0000-4000-8000-000000000001',
      cols: 120,
      rows: 35,
    };
    const resizePayload = { ptyId: pty.id, cols: 100, rows: 30 };
    const closePayload = { ptyId: pty.id };
    const connectPayload = {
      ownerId: 'oauth/google:account%2Fsegment',
      ptyId: pty.id,
      bridgeGeneration: '00000000-0000-4000-8000-000000000002',
      capability: 'a'.repeat(64),
    };
    const handlerDeps = deps({ terminalRuntime });

    expect(
      await handleControlRequest('session.terminal.create', session, createPayload, handlerDeps)
    ).toEqual({ ok: true, result: { pty } });
    expect(
      await handleControlRequest('session.terminal.resize', session, resizePayload, handlerDeps)
    ).toEqual({ ok: true, result: { pty } });
    expect(
      await handleControlRequest('session.terminal.close', session, closePayload, handlerDeps)
    ).toEqual({ ok: true, result: { success: true } });
    expect(
      await handleControlRequest('session.terminal.connect', session, connectPayload, handlerDeps)
    ).toEqual({ ok: true, result: { connected: true } });
    expect(calls).toEqual([
      { operation: 'create', identity: session, payload: createPayload },
      { operation: 'resize', identity: session, payload: resizePayload },
      { operation: 'close', identity: session, payload: closePayload },
      { operation: 'connect', identity: session, payload: connectPayload },
    ]);
  });

  it('rejects malformed terminal payloads and caller-controlled destinations', async () => {
    const terminalRuntime = fakeTerminalRuntime();
    const invalidPayloads: Array<[string, unknown]> = [
      ['session.terminal.create', { operationId: 'not-a-uuid', cols: 120, rows: 30 }],
      [
        'session.terminal.create',
        { operationId: '00000000-0000-4000-8000-000000000001', cols: 120 },
      ],
      ['session.terminal.resize', { ptyId: '../other', cols: 120, rows: 30 }],
      ['session.terminal.resize', { ptyId: pty.id, cols: 501, rows: 30 }],
      ['session.terminal.close', { ptyId: pty.id, unexpected: true }],
      [
        'session.terminal.connect',
        {
          ownerId: 'owner',
          ptyId: pty.id,
          bridgeGeneration: '00000000-0000-4000-8000-000000000002',
          capability: 'a'.repeat(64),
          url: 'wss://untrusted.example/steal',
        },
      ],
    ];

    for (const [operation, payload] of invalidPayloads) {
      expect(
        await handleControlRequest(operation, session, payload, deps({ terminalRuntime }))
      ).toEqual({
        ok: false,
        error: { code: 'protocol_error', message: 'Invalid payload', retryable: false },
      });
    }
  });

  it('returns safe terminal ownership errors without leaking unexpected failures', async () => {
    const payload = { ptyId: pty.id, cols: 100, rows: 30 };
    const ownedFailure = await handleControlRequest(
      'session.terminal.resize',
      session,
      payload,
      deps({
        terminalRuntime: fakeTerminalRuntime({
          resize: async () => {
            throw new ControlTerminalRuntimeError(
              'unauthorized',
              'Terminal ownership mismatch',
              false
            );
          },
        }),
      })
    );
    expect(ownedFailure).toEqual({
      ok: false,
      error: { code: 'unauthorized', message: 'Terminal ownership mismatch', retryable: false },
    });

    const unexpectedFailure = await handleControlRequest(
      'session.terminal.resize',
      session,
      payload,
      deps({
        terminalRuntime: fakeTerminalRuntime({
          resize: async () => {
            throw new Error('sensitive-capability-value');
          },
        }),
      })
    );
    expect(unexpectedFailure).toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'Terminal request failed', retryable: false },
    });
  });

  it('rejects invalid terminal runtime results', async () => {
    const result = await handleControlRequest(
      'session.terminal.connect',
      session,
      {
        ownerId: 'owner',
        ptyId: pty.id,
        bridgeGeneration: '00000000-0000-4000-8000-000000000002',
        capability: 'a'.repeat(64),
      },
      deps({
        terminalRuntime: fakeTerminalRuntime({
          connect: async () => {
            const result: { connected: true } = { connected: true };
            Reflect.set(result, 'connected', false);
            return result;
          },
        }),
      })
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'Invalid terminal result', retryable: false },
    });
  });

  it('cleans up only the detached session and shuts down on sandbox shutdown', async () => {
    const detached: unknown[] = [];
    let shutdowns = 0;
    const terminalRuntime = fakeTerminalRuntime({
      detachSession: async identity => {
        detached.push(identity);
      },
      shutdown: () => {
        shutdowns += 1;
      },
    });

    expect(
      await handleControlRequest('session.detach', session, {}, deps({ terminalRuntime }))
    ).toEqual({ ok: true, result: { detached: true } });
    expect(
      await handleControlRequest('sandbox.shutdown', undefined, {}, deps({ terminalRuntime }))
    ).toEqual({ ok: true, result: { shuttingDown: true } });
    expect(detached).toEqual([session]);
    expect(shutdowns).toBe(1);
  });

  it('rejects terminal operations when the runtime is unavailable', async () => {
    const result = await handleControlRequest(
      'session.terminal.close',
      session,
      { ptyId: pty.id },
      deps()
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'Terminal is not available', retryable: false },
    });
  });

  it('rejects unknown operations', async () => {
    const result = await handleControlRequest('sandbox.nope', undefined, {}, deps());
    expect(result).toEqual({
      ok: false,
      error: { code: 'unknown_operation', message: 'Unknown operation', retryable: false },
    });
  });
});

describe('production worktree deletion routes', () => {
  const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
  const directory = `/workspace/oauth-user/worktrees/${worktreeId}`;
  const siblingDirectory =
    '/workspace/oauth-user/worktrees/worktree_22222222-2222-4222-8222-222222222222';
  const sessionId = (index: number) => `ses_${String(index).padStart(26, '0')}`;
  const identity = (index: number, dir = directory) => ({
    sessionId: sessionId(index),
    kiloSessionId: sessionId(index),
    directory: dir,
  });
  const input = { worktreeId, directory, sessionIds: [sessionId(1)] };

  function protectCheckout() {
    const remove = spyOn(fsPromises, 'rm').mockResolvedValue(undefined);
    const stat = spyOn(fsPromises, 'lstat').mockResolvedValue({
      isSymbolicLink: () => false,
      isDirectory: () => true,
    } as fs.Stats);
    return {
      remove,
      restore: () => {
        remove.mockRestore();
        stat.mockRestore();
      },
    };
  }

  function cleanupServer() {
    const sessions = new Map([
      [sessionId(1), { id: sessionId(1), directory, parentID: undefined as string | undefined }],
      [sessionId(2), { id: sessionId(2), directory, parentID: undefined as string | undefined }],
      [sessionId(3), { id: sessionId(3), directory, parentID: sessionId(2) }],
    ]);
    const requests: Array<{ method: string; pathname: string; directory: string | null }> = [];
    const credentialedRequests: string[] = [];
    let ptyOpen = true;
    let disposed = false;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const url = new URL(request.url);
        const dir = url.searchParams.get('directory');
        requests.push({ method: request.method, pathname: url.pathname, directory: dir });
        if (request.headers.has('authorization') || request.headers.has('cookie')) {
          credentialedRequests.push(url.pathname);
        }
        if (dir !== directory) return Response.json({}, { status: 400 });
        if (url.pathname === '/api/session') {
          return Response.json({
            data: [...sessions.values()].filter(item => !item.parentID),
            cursor: { previous: null, next: null },
          });
        }
        const id = url.pathname.split('/')[2];
        if (url.pathname.startsWith('/session/') && id) {
          if (url.pathname.endsWith('/children')) {
            return Response.json([...sessions.values()].filter(item => item.parentID === id));
          }
          if (url.pathname.endsWith('/abort')) return Response.json(true);
          if (request.method === 'DELETE') {
            sessions.delete(id);
            return Response.json(true);
          }
          const found = sessions.get(id);
          return Response.json(found ?? {}, { status: found ? 200 : 404 });
        }
        if (url.pathname.startsWith('/background-process/session/')) return Response.json(true);
        if (url.pathname === '/interactive-terminal') return Response.json([]);
        if (url.pathname === '/pty') return Response.json(ptyOpen ? [{ id: 'pty_cleanup' }] : []);
        if (url.pathname === '/pty/pty_cleanup' && request.method === 'DELETE') {
          ptyOpen = false;
          return Response.json(true);
        }
        if (url.pathname === '/instance/dispose') {
          disposed = true;
          return Response.json(true);
        }
        return Response.json({}, { status: 404 });
      },
    });
    return {
      server,
      sessions,
      requests,
      credentialedRequests,
      isDisposed: () => disposed,
      hasPty: () => ptyOpen,
    };
  }

  it.each(['worktree.prepareDeletion', 'worktree.delete'] as const)(
    'validates %s payload and checkout directory before any runtime lookup or mutation',
    async operation => {
      const filesystem = protectCheckout();
      const calls: string[] = [];
      const handlerDeps = deps({
        kiloRuntimes: {
          get: dir => {
            calls.push(`get:${dir}`);
            return undefined;
          },
          attach: () => {
            calls.push('attach');
            throw new Error('Unexpected runtime startup');
          },
          detach: () => {
            calls.push('detach');
            return true;
          },
          deleteDirectory: async dir => {
            calls.push(`delete:${dir}`);
          },
          shutdown: () => {
            calls.push('shutdown');
          },
          isHealthy: () => true,
        },
      });
      try {
        for (const payload of [
          {},
          { ...input, worktreeId: 'worktree_invalid' },
          { ...input, sessionIds: ['ses_short'] },
          { ...input, unexpected: true },
          { ...input, directory: '' },
        ]) {
          expect(await handleControlRequest(operation, undefined, payload, handlerDeps)).toEqual({
            ok: false,
            error: { code: 'protocol_error', message: 'Invalid payload', retryable: false },
          });
        }
        for (const invalidDirectory of [
          '/workspace',
          siblingDirectory,
          `${directory}/..`,
          directory.replace('/oauth-user/', '/oauth-user/../oauth-user/'),
          `/workspace/not-a-uuid/oauth-user/worktrees/${worktreeId}`,
        ]) {
          expect(
            await handleControlRequest(
              operation,
              undefined,
              { ...input, directory: invalidDirectory },
              handlerDeps
            )
          ).toEqual({
            ok: false,
            error: {
              code: 'protocol_error',
              message: 'Invalid worktree directory',
              retryable: false,
            },
          });
        }
        expect(calls).toEqual([]);
        expect(filesystem.remove).not.toHaveBeenCalled();
      } finally {
        filesystem.restore();
      }
    }
  );

  it.each(['worktree.prepareDeletion', 'worktree.delete'] as const)(
    'refuses %s without runtime ownership before fencing or removing files',
    async operation => {
      const filesystem = protectCheckout();
      const handlerDeps = deps();
      handlerDeps.kiloRuntimes = undefined;
      try {
        expect(await handleControlRequest(operation, undefined, input, handlerDeps)).toEqual({
          ok: false,
          error: { code: 'not_ready', message: 'Kilo is not ready', retryable: true },
        });
        expect(() => assertDirectoryActive(directory)).not.toThrow();
        expect(filesystem.remove).not.toHaveBeenCalled();
      } finally {
        filesystem.restore();
      }
    }
  );

  it('prepares through the selected runtime HTTP client, discovering lazy roots and children after only matching commands quiesce', async () => {
    const filesystem = protectCheckout();
    const http = cleanupServer();
    const first = identity(1);
    const second = identity(6);
    const sibling = identity(4, siblingDirectory);
    http.sessions.set(second.kiloSessionId, {
      id: second.kiloSessionId,
      directory,
      parentID: undefined,
    });
    const preparationInput = { ...input, sessionIds: [first.kiloSessionId, second.kiloSessionId] };
    const started = new Map(
      [first, second, sibling].map(item => [item.kiloSessionId, Promise.withResolvers<void>()])
    );
    const completionResponses = new Map(
      [first, second, sibling].map(item => [
        item.kiloSessionId,
        Promise.withResolvers<Completion>(),
      ])
    );
    const abortStarted = new Map(
      [first, second].map(item => [item.kiloSessionId, Promise.withResolvers<void>()])
    );
    const abortResponses = new Map(
      [first, second].map(item => [item.kiloSessionId, Promise.withResolvers<boolean>()])
    );
    const aborted: string[] = [];
    const outcomes: Array<{ id: string; event: SessionEventPayload }> = [];
    const lookups: string[] = [];
    const handlerDeps = deps(
      {
        kiloClient: fakeKilo({
          serverUrl: http.server.url.toString(),
          sendCommand: options => {
            started.get(options.sessionId)?.resolve();
            const response = completionResponses.get(options.sessionId);
            if (!response) throw new Error('Unexpected command session');
            return response.promise;
          },
          abortSession: options => {
            aborted.push(options.sessionId);
            abortStarted.get(options.sessionId)?.resolve();
            return abortResponses.get(options.sessionId)?.promise ?? Promise.resolve(true);
          },
        }),
        emitSessionEvent: (item, event) => outcomes.push({ id: item.kiloSessionId, event }),
      },
      first
    );
    const runtimes = handlerDeps.kiloRuntimes;
    const selected = runtimes?.get(directory);
    if (!runtimes || !selected) throw new Error('Expected selected worktree runtime');
    const otherRuntime = {
      ...selected,
      directory: siblingDirectory,
      kiloClient: fakeKilo({
        sendCommand: options => {
          started.get(options.sessionId)?.resolve();
          const response = completionResponses.get(options.sessionId);
          if (!response) throw new Error('Unexpected sibling command');
          return response.promise;
        },
        abortSession: async options => {
          aborted.push(options.sessionId);
          return true;
        },
      }),
    };
    runtimes.get = dir => {
      lookups.push(dir);
      return dir === directory ? selected : dir === siblingDirectory ? otherRuntime : undefined;
    };
    const attach = spyOn(runtimes, 'attach');
    let preparation: ReturnType<typeof handleControlRequest> | undefined;
    let prepared = false;
    try {
      for (const item of [first, second, sibling]) {
        rememberAttachedRoot(item.kiloSessionId, item.directory);
        expect(
          await handleControlRequest(
            'session.prompt',
            item,
            {
              ...promptPayload,
              messageId: `message_${item.kiloSessionId}`,
              turn: { type: 'command', command: 'review', arguments: '' },
            },
            handlerDeps
          )
        ).toMatchObject({ ok: true, result: { status: 'accepted' } });
      }
      await Promise.all([...started.values()].map(item => item.promise));
      lookups.length = 0;
      expect(rootForSession(sessionId(2))).toBeUndefined();
      expect(rootForSession(sessionId(3))).toBeUndefined();
      const siblingTask = handlerDeps.tasks.get(sibling.kiloSessionId);
      preparation = handleControlRequest(
        'worktree.prepareDeletion',
        undefined,
        preparationInput,
        handlerDeps
      ).then(result => {
        prepared = true;
        return result;
      });
      await Promise.all([...abortStarted.values()].map(item => item.promise));
      expect(handlerDeps.tasks.get(first.kiloSessionId)?.signal.aborted).toBe(true);
      expect(handlerDeps.tasks.get(second.kiloSessionId)?.signal.aborted).toBe(true);
      expect(siblingTask?.signal.aborted).toBe(false);
      expect(prepared).toBe(false);
      expect(http.requests).toEqual([]);
      expect(
        await handleControlRequest('session.attach', identity(5), { kilo }, handlerDeps)
      ).toEqual({
        ok: false,
        error: { code: 'not_ready', message: 'Worktree is being deleted', retryable: false },
      });
      expect(attach).not.toHaveBeenCalled();
      abortResponses.get(first.kiloSessionId)?.resolve(true);
      await handlerDeps.tasks.get(first.kiloSessionId)?.done;
      expect(prepared).toBe(false);
      expect(http.requests).toEqual([]);
      abortResponses.get(second.kiloSessionId)?.resolve(true);
      expect(
        await withTimeoutAndAbort(preparation, {
          timeoutMs: 1_000,
          timeoutMessage: 'Deletion preparation waited for command completion',
          abortMessage: 'Test cancelled',
        })
      ).toEqual({
        ok: true,
        result: {
          prepared: true,
          sessionIds: [sessionId(1), sessionId(6), sessionId(2), sessionId(3)],
        },
      });
      expect(handlerDeps.tasks.size).toBe(1);
      expect(handlerDeps.tasks.get(sibling.kiloSessionId)).toBe(siblingTask);
      expect(siblingTask?.signal.aborted).toBe(false);
      expect(aborted.toSorted()).toEqual([first.kiloSessionId, second.kiloSessionId]);
      expect(outcomes.map(item => item.id).toSorted()).toEqual([
        first.kiloSessionId,
        second.kiloSessionId,
      ]);
      expect(
        outcomes.every(
          item =>
            item.event.type === 'session.message.outcome' &&
            item.event.properties.status === 'cancelled'
        )
      ).toBe(true);
      expect(lookups).toEqual([directory]);
      expect(http.requests.every(request => request.directory === directory)).toBe(true);
      expect(http.requests).toContainEqual({
        method: 'POST',
        pathname: `/session/${sessionId(3)}/abort`,
        directory,
      });
      expect(http.credentialedRequests).toEqual([]);
      expect(filesystem.remove).not.toHaveBeenCalled();
    } finally {
      for (const response of abortResponses.values()) response.resolve(true);
      for (const response of completionResponses.values()) response.resolve(completion());
      await preparation;
      await waitForTasks(handlerDeps);
      attach.mockRestore();
      await http.server.stop(true);
      filesystem.restore();
    }
  });

  it('deletes through the selected runtime and awaits directory terminals and retirement before removing its checkout and snapshots', async () => {
    const filesystem = protectCheckout();
    const http = cleanupServer();
    const first = identity(1);
    const sibling = identity(4, siblingDirectory);
    const activity = createSessionActivityRegistry(() => 100);
    for (const item of [first, identity(2), sibling]) {
      rememberAttachedRoot(item.kiloSessionId, item.directory);
      activity.attach(item.kiloSessionId);
      activity.markActive(item.kiloSessionId);
    }
    rememberChildSession({ childId: sessionId(3), parentId: sessionId(2), directory });
    const terminals = new Set([directory, siblingDirectory]);
    const detaching = Promise.withResolvers<void>();
    const detached = Promise.withResolvers<void>();
    const retiring = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    const lookups: string[] = [];
    const retirements: string[] = [];
    const handlerDeps = deps(
      {
        activity,
        sessions: [first, identity(2), identity(3), sibling].map(item => ({
          kiloSessionId: item.kiloSessionId,
          lastActivityAt: 100,
        })),
        kiloClient: fakeKilo({ serverUrl: http.server.url.toString() }),
        terminalRuntime: fakeTerminalRuntime({
          detachDirectory: async dir => {
            expect(dir).toBe(directory);
            detaching.resolve();
            await detached.promise;
            terminals.delete(dir);
          },
        }),
      },
      first
    );
    const runtimes = handlerDeps.kiloRuntimes;
    const selected = runtimes?.get(directory);
    if (!runtimes || !selected) throw new Error('Expected selected worktree runtime');
    runtimes.get = dir => {
      lookups.push(dir);
      return dir === directory ? selected : undefined;
    };
    runtimes.deleteDirectory = async dir => {
      retirements.push(dir);
      expect(http.sessions.size).toBe(0);
      expect(http.hasPty()).toBe(false);
      expect(http.isDisposed()).toBe(true);
      expect(terminals).toEqual(new Set([siblingDirectory]));
      retiring.resolve();
      await retired.promise;
    };
    let deletion: ReturnType<typeof handleControlRequest> | undefined;
    try {
      deletion = handleControlRequest(
        'worktree.delete',
        undefined,
        { ...input, sessionIds: [sessionId(1), sessionId(2), sessionId(3)] },
        handlerDeps
      );
      await detaching.promise;
      expect(retirements).toEqual([]);
      expect(filesystem.remove).not.toHaveBeenCalled();
      expect(http.isDisposed()).toBe(false);
      detached.resolve();
      await retiring.promise;
      expect(filesystem.remove).not.toHaveBeenCalled();
      expect(rootForSession(first.kiloSessionId)).toBe(first.kiloSessionId);
      retired.resolve();
      expect(await deletion).toEqual({
        ok: true,
        result: { deleted: true, sessionIds: [sessionId(1), sessionId(2), sessionId(3)] },
      });
      expect(lookups).toEqual([directory]);
      expect(retirements).toEqual([directory]);
      expect(filesystem.remove.mock.calls).toEqual([[directory, { recursive: true, force: true }]]);
      expect(handlerDeps.sessions).toEqual([
        { kiloSessionId: sibling.kiloSessionId, lastActivityAt: 100 },
      ]);
      expect(activity.snapshots()).toEqual([
        { kiloSessionId: sibling.kiloSessionId, state: 'active', idleForMs: 0, waitingOn: 'model' },
      ]);
      expect(rootForSession(sessionId(1))).toBeUndefined();
      expect(rootForSession(sessionId(2))).toBeUndefined();
      expect(rootForSession(sessionId(3))).toBeUndefined();
      expect(rootForSession(sibling.kiloSessionId)).toBe(sibling.kiloSessionId);
      expect(http.requests.every(request => request.directory === directory)).toBe(true);
      expect(http.credentialedRequests).toEqual([]);
    } finally {
      detached.resolve();
      retired.resolve();
      await deletion;
      await http.server.stop(true);
      filesystem.restore();
    }
  });

  it('idempotently prepares and deletes an absent runtime without global lookup, startup, or credentials', async () => {
    const filesystem = protectCheckout();
    const first = identity(1);
    const sibling = identity(4, siblingDirectory);
    const activity = createSessionActivityRegistry(() => 100);
    for (const item of [first, sibling]) {
      rememberAttachedRoot(item.kiloSessionId, item.directory);
      activity.attach(item.kiloSessionId);
    }
    const lookups: string[] = [];
    const retirements: string[] = [];
    const detached: string[] = [];
    const forbidden: string[] = [];
    const siblingRuntime: WorktreeKiloRuntime = {
      directory: siblingDirectory,
      scopeId: path.basename(siblingDirectory),
      env: {},
      signal: new AbortController().signal,
      kiloClient: {
        ...fakeKilo(),
        get serverUrl(): string {
          forbidden.push('sibling credentials');
          throw new Error('Sibling runtime must not be used for cleanup');
        },
      },
    };
    const handlerDeps = deps(
      {
        activity,
        sessions: [first, sibling].map(item => ({
          kiloSessionId: item.kiloSessionId,
          lastActivityAt: 100,
        })),
        kiloRuntimes: {
          get: dir => {
            lookups.push(dir);
            if (dir === directory) return undefined;
            forbidden.push('unscoped lookup');
            return siblingRuntime;
          },
          attach: () => {
            forbidden.push('startup');
            throw new Error('Cleanup must not start a runtime');
          },
          detach: () => {
            forbidden.push('detach');
            return false;
          },
          deleteDirectory: async dir => {
            retirements.push(dir);
          },
          isHealthy: () => true,
          shutdown: () => {
            forbidden.push('shutdown');
          },
        },
        terminalRuntime: fakeTerminalRuntime({
          detachDirectory: async dir => {
            detached.push(dir);
          },
        }),
      },
      first
    );
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(
          await handleControlRequest('worktree.prepareDeletion', undefined, input, handlerDeps)
        ).toEqual({ ok: true, result: { prepared: true, sessionIds: input.sessionIds } });
        expect(retirements).toHaveLength(attempt);
        expect(
          await handleControlRequest('worktree.delete', undefined, input, handlerDeps)
        ).toEqual({ ok: true, result: { deleted: true, sessionIds: input.sessionIds } });
      }
      expect(lookups).toEqual([directory, directory, directory, directory]);
      expect(retirements).toEqual([directory, directory]);
      expect(detached).toEqual([directory, directory]);
      expect(filesystem.remove.mock.calls).toEqual([
        [directory, { recursive: true, force: true }],
        [directory, { recursive: true, force: true }],
      ]);
      expect(forbidden).toEqual([]);
      expect(handlerDeps.sessions).toEqual([
        { kiloSessionId: sibling.kiloSessionId, lastActivityAt: 100 },
      ]);
      expect(activity.snapshots()).toEqual([
        { kiloSessionId: sibling.kiloSessionId, state: 'idle', idleForMs: 0 },
      ]);
      expect(rootForSession(first.kiloSessionId)).toBeUndefined();
      expect(rootForSession(sibling.kiloSessionId)).toBe(sibling.kiloSessionId);
    } finally {
      filesystem.restore();
    }
  });
});

describe('owned control execution', () => {
  it('admits a command before completion and does not redispatch it after the RPC deadline', async () => {
    const finished = Promise.withResolvers<Completion>();
    const events: SessionEventPayload[] = [];
    let submissions = 0;
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        sendCommand: () => {
          submissions += 1;
          return finished.promise;
        },
      }),
      emitSessionEvent: (_session, event) => events.push(event),
    });
    const payload = {
      ...promptPayload,
      turn: { type: 'command', command: 'review', arguments: '' },
    };
    const admittedAt = Date.now();
    expect(await handleControlRequest('session.prompt', session, payload, handlerDeps)).toEqual({
      ok: true,
      result: { messageId: 'msg_1', status: 'accepted' },
    });
    setSystemTime(admittedAt + SANDBOX_CONTROL_REQUEST_TIMEOUT_MS + 1);
    expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({
      state: 'active',
      pendingMessages: 1,
    });
    expect(await handleControlRequest('session.prompt', session, payload, handlerDeps)).toEqual({
      ok: true,
      result: { messageId: 'msg_1', status: 'existing' },
    });
    expect(
      await handleControlRequest(
        'session.prompt',
        session,
        { ...payload, messageId: 'msg_2' },
        handlerDeps
      )
    ).toMatchObject({ ok: false, error: { code: 'session_busy', retryable: true } });
    expect(
      await handleControlRequest('session.attach', session, { kilo }, handlerDeps)
    ).toMatchObject({ ok: false, error: { code: 'session_busy', retryable: true } });
    expect(submissions).toBe(1);
    expect(events).toEqual([]);
    finished.resolve(completion());
    await waitForTasks(handlerDeps);
    expect(events).toEqual([
      { type: 'session.message.outcome', properties: { messageId: 'msg_1', status: 'completed' } },
    ]);
    expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({ state: 'idle', pendingMessages: 0 });
  });

  it('emits one message-scoped outcome even when completion precedes delivery of the acknowledgement', async () => {
    const releaseAck = Promise.withResolvers<void>();
    const events: SessionEventPayload[] = [];
    const identities: unknown[] = [];
    const handlerDeps = deps({
      emitSessionEvent: (identity, event) => {
        identities.push(identity);
        events.push(event);
      },
    });
    let acknowledged = false;
    const response = handleControlRequest(
      'session.prompt',
      session,
      promptPayload,
      handlerDeps
    ).then(async result => {
      await releaseAck.promise;
      acknowledged = true;
      return result;
    });
    await waitForTasks(handlerDeps);
    expect(acknowledged).toBe(false);
    expect(events).toEqual([
      { type: 'session.message.outcome', properties: { messageId: 'msg_1', status: 'completed' } },
    ]);
    expect(identities).toEqual([session]);
    releaseAck.resolve();
    expect(await response).toMatchObject({ ok: true });
    expect(events).toHaveLength(1);
  });

  it('reports asynchronous submission failures after admission without leaking API diagnostics', async () => {
    const failed = Promise.withResolvers<Completion>();
    const events: SessionEventPayload[] = [];
    const handlerDeps = deps({
      kiloClient: fakeKilo({ sendCommand: () => failed.promise }),
      emitSessionEvent: (_session, event) => events.push(event),
    });
    const accepted = await handleControlRequest(
      'session.prompt',
      session,
      {
        ...promptPayload,
        turn: { type: 'command', command: 'review', arguments: '' },
      },
      handlerDeps
    );
    expect(accepted).toMatchObject({ ok: true });
    failed.reject(new Error('private-token-from-upstream'));
    await waitForTasks(handlerDeps);
    expect(events).toEqual([
      {
        type: 'session.message.outcome',
        properties: {
          messageId: 'msg_1',
          status: 'failed',
          reason: 'Kilo execution failed',
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('private-token-from-upstream');
  });

  it.each([
    [{ name: 'MessageAbortedError', data: { message: 'aborted' } }, 'cancelled'],
    [{ name: 'UnknownError', data: { message: 'model failed' } }, 'failed'],
  ] as const)('classifies returned assistant error %j as %s', async (error, status) => {
    const events: SessionEventPayload[] = [];
    const handlerDeps = deps({
      kiloClient: fakeKilo({ sendPrompt: async () => completion(error) }),
      emitSessionEvent: (_session, event) => events.push(event),
    });
    expect(
      await handleControlRequest('session.prompt', session, promptPayload, handlerDeps)
    ).toMatchObject({ ok: true });
    await waitForTasks(handlerDeps);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'session.message.outcome',
      properties: { messageId: 'msg_1', status },
    });
  });

  it('does not classify raw recoverable errors or native session-parent closes as message outcomes', async () => {
    const finished = Promise.withResolvers<Completion>();
    const events: SessionEventPayload[] = [];
    const handlerDeps = deps({
      kiloClient: fakeKilo({ sendCommand: () => finished.promise }),
      emitSessionEvent: (_session, event) => events.push(event),
    });
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    await handleControlRequest(
      'session.prompt',
      session,
      {
        ...promptPayload,
        turn: { type: 'command', command: 'review', arguments: '' },
      },
      handlerDeps
    );
    for await (const event of unfilteredKiloEvents([
      {
        directory: session.directory,
        payload: {
          type: 'session.error',
          properties: { sessionID: session.kiloSessionId, error: { name: 'ContextOverflowError' } },
        },
      },
      {
        directory: session.directory,
        payload: {
          type: 'session.turn.close',
          properties: {
            sessionID: session.kiloSessionId,
            parentID: 'parent-session',
            reason: 'error',
          },
        },
      },
    ])) {
      updateSessionSnapshots(event, handlerDeps.sessions);
    }
    expect(events).toEqual([]);
    expect(handlerDeps.tasks.size).toBe(1);
    finished.resolve(completion());
    await waitForTasks(handlerDeps);
    expect(events[0]?.properties).toEqual({ messageId: 'msg_1', status: 'completed' });
  });

  it('fences stale cancellation and late completion after admitting replacement work', async () => {
    const running = Promise.withResolvers<Completion>();
    const started = Promise.withResolvers<void>();
    const replacement = Promise.withResolvers<Completion>();
    const replacementStarted = Promise.withResolvers<void>();
    const abortStarted = Promise.withResolvers<void>();
    const remoteStopped = Promise.withResolvers<boolean>();
    const finalized: Array<string | undefined> = [];
    let taskSignal: AbortSignal | undefined;
    let aborts = 0;
    const { handlerDeps, events, retired } = runtimeDeps(
      fakeKilo({
        sendPrompt: opts => {
          if (opts.messageId === 'newer') {
            taskSignal = opts.signal;
            started.resolve();
            return running.promise;
          }
          replacementStarted.resolve();
          return replacement.promise;
        },
        abortSession: opts => {
          expect(opts.directory).toBe(session.directory);
          expect(opts.signal?.aborted).toBe(false);
          aborts += 1;
          abortStarted.resolve();
          return remoteStopped.promise;
        },
      })
    );
    handlerDeps.runAutoCommit = async opts => {
      finalized.push(opts.messageId);
      return { success: true };
    };
    const payload = { ...promptPayload, finalization: { autoCommit: true } };
    try {
      await handleControlRequest(
        'session.prompt',
        session,
        { ...payload, messageId: 'newer' },
        handlerDeps
      );
      await started.promise;
      expect(
        await handleControlRequest('session.abort', session, { messageId: 'older' }, handlerDeps)
      ).toEqual({ ok: true, result: { status: 'already_idle' } });
      expect(taskSignal?.aborted).toBe(false);
      expect(aborts).toBe(0);
      const aborting = handleControlRequest(
        'session.abort',
        session,
        { messageId: 'newer' },
        handlerDeps
      );
      await abortStarted.promise;
      expect(taskSignal?.aborted).toBe(true);
      expect(
        await handleControlRequest('session.prompt', session, payload, handlerDeps)
      ).toMatchObject({ ok: false });
      expect(events).toEqual([]);
      expect(handlerDeps.tasks.get(session.kiloSessionId)?.messageId).toBe('newer');
      remoteStopped.resolve(true);
      expect(await aborting).toEqual({ ok: true, result: { status: 'aborted' } });
      expect(events).toEqual([
        {
          type: 'session.message.outcome',
          properties: { messageId: 'newer', status: 'cancelled', reason: 'Session aborted' },
        },
      ]);
      expect(handlerDeps.tasks.size).toBe(0);
      expect(await handleControlRequest('session.prompt', session, payload, handlerDeps)).toEqual({
        ok: true,
        result: { messageId: 'msg_1', status: 'accepted' },
      });
      await replacementStarted.promise;
      const replacementTask = handlerDeps.tasks.get(session.kiloSessionId);
      expect(replacementTask?.messageId).toBe('msg_1');
      const oldCompletion = completion();
      running.resolve({
        ...oldCompletion,
        info: { ...oldCompletion.info, parentID: 'newer' },
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(handlerDeps.tasks.get(session.kiloSessionId)).toBe(replacementTask);
      expect(replacementTask?.signal.aborted).toBe(false);
      expect(finalized).toEqual([]);
      expect(events).toHaveLength(1);
      expect(
        await handleControlRequest(
          'session.prompt',
          session,
          { ...payload, messageId: 'third' },
          handlerDeps
        )
      ).toMatchObject({ ok: false });
      const nextCompletion = completion();
      replacement.resolve({
        ...nextCompletion,
        info: { ...nextCompletion.info, id: 'assistant_next' },
      });
      await waitForTasks(handlerDeps);
      expect(finalized).toEqual(['assistant_next']);
      expect(events).toHaveLength(2);
      expect(events[1]?.properties).toEqual({ messageId: 'msg_1', status: 'completed' });
      expect(aborts).toBe(1);
      expect(retired).toEqual([]);
      expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({
        state: 'idle',
        kilo: { ready: true },
      });
    } finally {
      remoteStopped.resolve(true);
      running.resolve(completion());
      replacement.resolve(completion());
      await waitForTasks(handlerDeps);
    }
  });

  it.each(['false', 'malformed', 'HTTP failure'] as const)(
    'retires and rejects replacement work after an abort returns %s',
    async response => {
      const running = Promise.withResolvers<Completion>();
      const submissions: Array<string | undefined> = [];
      const { handlerDeps, events, retired } = runtimeDeps(
        fakeKilo({
          sendCommand: opts => {
            submissions.push(opts.messageId);
            return running.promise;
          },
          abortSession: async () => {
            if (response === 'HTTP failure') throw new Error('HTTP 500');
            return response === 'false' ? false : ({} as boolean);
          },
        })
      );
      const payload = {
        ...promptPayload,
        turn: { type: 'command', command: 'review', arguments: '' },
      };
      try {
        await handleControlRequest('session.prompt', session, payload, handlerDeps);
        expect(
          await handleControlRequest('session.abort', session, { messageId: 'msg_1' }, handlerDeps)
        ).toMatchObject({ ok: false, error: { code: 'not_ready' } });
        expect(retired).toEqual(['Kilo cancellation failed']);
        expect(handlerDeps.signal?.aborted).toBe(true);
        expect(buildHeartbeatPayload(handlerDeps).kilo.ready).toBe(false);
        expect(handlerDeps.tasks.size).toBe(0);
        expect(
          await handleControlRequest(
            'session.prompt',
            session,
            { ...payload, messageId: 'next' },
            { ...handlerDeps }
          )
        ).toMatchObject({ ok: false, error: { code: 'not_ready' } });
        expect(submissions).toEqual(['msg_1']);
        running.resolve(completion());
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(events).toHaveLength(1);
        expect(events[0]?.properties.messageId).toBe('msg_1');
      } finally {
        running.resolve(completion());
        await waitForTasks(handlerDeps);
      }
    }
  );

  it('fails closed when the actual Kilo adapter receives an empty JSON abort response', async () => {
    const running = Promise.withResolvers<Completion>();
    const started = Promise.withResolvers<void>();
    const submissions: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === `/session/${session.kiloSessionId}/message`) {
          const body = (await request.json()) as { messageID: string };
          submissions.push(body.messageID);
          started.resolve();
          return Response.json(await running.promise);
        }
        if (pathname === `/session/${session.kiloSessionId}/abort`) {
          return new Response(null, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 404 });
      },
    });
    const url = server.url.toString();
    const { handlerDeps, retired } = runtimeDeps(
      createWrapperKiloClient(createKiloClient({ baseUrl: url }), url, session.directory)
    );
    try {
      await handleControlRequest('session.prompt', session, promptPayload, handlerDeps);
      await started.promise;
      expect(
        await handleControlRequest('session.abort', session, { messageId: 'msg_1' }, handlerDeps)
      ).toMatchObject({ ok: false, error: { code: 'not_ready' } });
      expect(retired).toEqual(['Kilo cancellation failed']);
      expect(handlerDeps.signal?.aborted).toBe(true);
      expect(handlerDeps.tasks.size).toBe(0);
      expect(
        await handleControlRequest(
          'session.prompt',
          session,
          { ...promptPayload, messageId: 'next' },
          { ...handlerDeps }
        )
      ).toMatchObject({ ok: false, error: { code: 'not_ready' } });
      expect(submissions).toEqual(['msg_1']);
    } finally {
      running.resolve(completion());
      await waitForTasks(handlerDeps);
      await server.stop(true);
    }
  });

  it('bounds a hanging abort and cannot revive the runtime when its acknowledgement arrives late', async () => {
    const timers = spyOn(globalThis, 'setTimeout');
    const running = Promise.withResolvers<Completion>();
    const abortStarted = Promise.withResolvers<AbortSignal>();
    const remoteStopped = Promise.withResolvers<boolean>();
    const { handlerDeps, events, retired } = runtimeDeps(
      fakeKilo({
        sendCommand: () => running.promise,
        abortSession: opts => {
          if (!opts.signal) throw new Error('Missing abort request signal');
          abortStarted.resolve(opts.signal);
          return remoteStopped.promise;
        },
      })
    );
    try {
      await handleControlRequest(
        'session.prompt',
        session,
        { ...promptPayload, turn: { type: 'command', command: 'review', arguments: '' } },
        handlerDeps
      );
      const aborting = handleControlRequest(
        'session.abort',
        session,
        { messageId: 'msg_1' },
        handlerDeps
      );
      const abortSignal = await abortStarted.promise;
      expect(abortSignal.aborted).toBe(false);
      expect(handlerDeps.tasks.get(session.kiloSessionId)?.messageId).toBe('msg_1');
      expect(events).toEqual([]);
      expect(
        await handleControlRequest(
          'session.prompt',
          session,
          { ...promptPayload, messageId: 'next' },
          handlerDeps
        )
      ).toMatchObject({ ok: false });
      const deadline = timers.mock.calls.find(
        ([, ms]) => ms === KILO_CONTROL_REQUEST_TIMEOUT_MS
      )?.[0];
      if (typeof deadline !== 'function') throw new Error('Missing abort request deadline');
      deadline();
      expect(await aborting).toMatchObject({ ok: false, error: { code: 'not_ready' } });
      expect(abortSignal.aborted).toBe(true);
      expect(retired).toEqual(['Kilo cancellation failed']);
      expect(handlerDeps.signal?.aborted).toBe(true);
      remoteStopped.resolve(true);
      running.resolve(completion());
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(handlerDeps.tasks.size).toBe(0);
      expect(events).toHaveLength(1);
      expect(buildHeartbeatPayload(handlerDeps).kilo.ready).toBe(false);
      expect(
        await handleControlRequest(
          'session.prompt',
          session,
          { ...promptPayload, messageId: 'next' },
          { ...handlerDeps }
        )
      ).toMatchObject({ ok: false, error: { code: 'not_ready' } });
    } finally {
      remoteStopped.resolve(true);
      running.resolve(completion());
      await waitForTasks(handlerDeps);
      timers.mockRestore();
    }
  });

  it('retires execution that exceeds the explicit maximum even while waiting for input', async () => {
    const timers = spyOn(globalThis, 'setTimeout');
    const running = Promise.withResolvers<Completion>();
    const started = Promise.withResolvers<void>();
    const retired: string[] = [];
    const events: SessionEventPayload[] = [];
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        sendPrompt: () => {
          started.resolve();
          return running.promise;
        },
      }),
      emitSessionEvent: (_session, event) => events.push(event),
      retireRuntime: reason => {
        retired.push(reason);
        handlerDeps.kiloReady = false;
      },
    });
    try {
      rememberAttachedRoot(session.kiloSessionId, session.directory);
      await handleControlRequest('session.prompt', session, promptPayload, handlerDeps);
      await started.promise;
      updateSessionSnapshots(
        {
          type: 'question.asked',
          properties: { sessionID: session.kiloSessionId, id: 'question_1' },
        },
        handlerDeps.sessions
      );
      expect(buildHeartbeatPayload(handlerDeps).sessions[0]?.waitingOn).toBe('input');
      const deadline = timers.mock.calls.find(
        ([, ms]) => ms === SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS
      )?.[0];
      if (typeof deadline !== 'function') throw new Error('missing owned execution deadline');
      deadline();
      await waitForTasks(handlerDeps);
      expect(retired).toEqual(['Execution exceeded the 60 minute limit']);
      expect(events[0]?.properties).toEqual({
        messageId: 'msg_1',
        status: 'failed',
        reason: 'Execution exceeded the 60 minute limit',
      });
      expect(buildHeartbeatPayload(handlerDeps).kilo.ready).toBe(false);
      expect(
        await handleControlRequest(
          'session.prompt',
          session,
          { ...promptPayload, messageId: 'next' },
          handlerDeps
        )
      ).toMatchObject({ ok: false });
    } finally {
      running.resolve(completion());
      timers.mockRestore();
    }
  });
});

describe('control finalization and compact', () => {
  it.each([true, false])(
    'keeps bootstrap state out of auto-commit with repository edits=%s',
    async editRepository => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-autocommit-'));
      const source = path.join(root, 'source');
      const remote = path.join(root, 'remote.git');
      const workspace = path.join(root, 'workspace');
      const identity = {
        sessionId: 'ses_autocommit',
        kiloSessionId: 'kilo_autocommit',
        directory: workspace,
      };
      const events: SessionEventPayload[] = [];
      const git = async (args: string[], cwd = root): Promise<string> => {
        const result = await runProcess('git', args, { cwd });
        if (result.exitCode !== 0) throw new Error(`Fixture git ${args[0]} failed`);
        return result.stdout;
      };
      const handlerDeps = deps(
        {
          kiloClient: fakeKilo({
            sendPrompt: async () => {
              if (editRepository)
                fs.writeFileSync(path.join(workspace, 'result.txt'), 'normal control turn');
              return completion();
            },
          }),
          emitSessionEvent: (_session, event) => events.push(event),
        },
        identity
      );
      try {
        await git(['init', '--bare', remote]);
        await git(['init', '--initial-branch=work', source]);
        fs.writeFileSync(path.join(source, 'initial.txt'), 'initial');
        await git(['add', '.'], source);
        await git(
          [
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.test',
            'commit',
            '-m',
            'initial',
          ],
          source
        );
        await git(['remote', 'add', 'origin', remote], source);
        await git(['push', '-u', 'origin', 'work'], source);
        await git(['symbolic-ref', 'HEAD', 'refs/heads/work'], remote);
        expect(
          await handleControlRequest(
            'session.attach',
            identity,
            { kilo, git: { url: remote } },
            handlerDeps
          )
        ).toMatchObject({ ok: true });
        expect(await git(['status', '--porcelain'], workspace)).toBe('');
        expect(
          await handleControlRequest(
            'session.prompt',
            identity,
            { ...promptPayload, finalization: { autoCommit: true } },
            handlerDeps
          )
        ).toEqual({ ok: true, result: { messageId: 'msg_1', status: 'accepted' } });
        await waitForTasks(handlerDeps);
        const committed = events.find(event => event.type === 'autocommit_completed')?.properties;
        const branch = editRepository ? `session/${kilo.scopeId}` : 'work';
        expect((await git(['branch', '--show-current'], workspace)).trim()).toBe(
          `session/${kilo.scopeId}`
        );
        expect((await git(['rev-list', '--count', 'refs/heads/work'], remote)).trim()).toBe('1');
        if (editRepository) {
          expect(await git(['show', `refs/heads/${branch}:result.txt`], remote)).toBe(
            'normal control turn'
          );
          expect((await git(['log', '-1', '--format=%an/%ae'], workspace)).trim()).toBe(
            'Kilo Code Cloud/agent@kilocode.ai'
          );
          expect(committed).toMatchObject({
            success: true,
            messageId: 'assistant_1',
            commitMessage: 'Apply normal control turn',
          });
        } else {
          expect(committed).toMatchObject({ success: true, skipped: true });
        }
        expect(
          (await git(['ls-tree', '-r', '--name-only', `refs/heads/${branch}`], remote)).trim()
        ).toBe(editRepository ? 'initial.txt\nresult.txt' : 'initial.txt');
        expect((await git(['rev-list', '--count', `refs/heads/${branch}`], remote)).trim()).toBe(
          editRepository ? '2' : '1'
        );
        expect(await git(['status', '--porcelain'], workspace)).toBe('');
        expect(events.at(-1)).toEqual({
          type: 'session.message.outcome',
          properties: { messageId: 'msg_1', status: 'completed' },
        });
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it('retains ownership and the finalizing heartbeat through auto-commit and condensation', async () => {
    const committing = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<{ success: boolean }>();
    const condensing = Promise.withResolvers<void>();
    const condensed = Promise.withResolvers<boolean>();
    const events: SessionEventPayload[] = [];
    const handlerDeps = deps({
      runAutoCommit: async options => {
        expect(options.workspacePath).toBe(session.directory);
        expect(options.signal?.aborted).toBe(false);
        options.onEvent({
          streamEventType: 'autocommit_started',
          timestamp: new Date().toISOString(),
          data: { message: 'Committing', messageId: options.messageId },
        });
        committing.resolve();
        const result = await committed.promise;
        options.onEvent({
          streamEventType: 'autocommit_completed',
          timestamp: new Date().toISOString(),
          data: { success: result.success, message: 'Committed', messageId: options.messageId },
        });
        return result;
      },
      kiloClient: fakeKilo({
        summarizeSession: options => {
          expect(options).toMatchObject({
            sessionId: session.kiloSessionId,
            directory: session.directory,
            model: { providerID: 'kilo', modelID: promptPayload.agent.model },
            auto: true,
            signal: expect.any(AbortSignal),
          });
          condensing.resolve();
          return condensed.promise;
        },
      }),
      emitSessionEvent: (_session, event) => events.push(event),
    });
    const payload = {
      ...promptPayload,
      finalization: { autoCommit: true, condenseOnComplete: true },
    };
    expect(
      await handleControlRequest('session.prompt', session, payload, handlerDeps)
    ).toMatchObject({ ok: true });
    await committing.promise;
    expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({
      state: 'finalizing',
      pendingMessages: 1,
      sessions: [{ state: 'finalizing', waitingOn: 'finalizing' }],
    });
    expect(
      await handleControlRequest('session.prompt', session, payload, handlerDeps)
    ).toMatchObject({ ok: true, result: { status: 'existing' } });
    expect(
      await handleControlRequest(
        'session.prompt',
        session,
        { ...payload, messageId: 'next' },
        handlerDeps
      )
    ).toMatchObject({ ok: false });
    committed.resolve({ success: true });
    await condensing.promise;
    expect(events.some(event => event.type === 'session.message.outcome')).toBe(false);
    expect(buildHeartbeatPayload(handlerDeps).state).toBe('finalizing');
    condensed.resolve(true);
    await waitForTasks(handlerDeps);
    expect(events.map(event => event.type)).toEqual([
      'autocommit_started',
      'autocommit_completed',
      'status',
      'status',
      'session.message.outcome',
    ]);
    expect(events.at(-1)?.properties).toEqual({ messageId: 'msg_1', status: 'completed' });
  });

  it('cancels finalization without admitting a newer message before quiescence', async () => {
    const committing = Promise.withResolvers<AbortSignal>();
    const stopped = Promise.withResolvers<{ success: boolean }>();
    const events: SessionEventPayload[] = [];
    const handlerDeps = deps({
      runAutoCommit: options => {
        if (!options.signal) throw new Error('Missing finalization signal');
        committing.resolve(options.signal);
        return stopped.promise;
      },
      emitSessionEvent: (_session, event) => events.push(event),
    });
    await handleControlRequest(
      'session.prompt',
      session,
      { ...promptPayload, finalization: { autoCommit: true } },
      handlerDeps
    );
    const signal = await committing.promise;
    const cancelled = handleControlRequest(
      'session.abort',
      session,
      { messageId: 'msg_1' },
      handlerDeps
    );
    expect(signal.aborted).toBe(true);
    expect(
      await handleControlRequest(
        'session.prompt',
        session,
        { ...promptPayload, messageId: 'next' },
        handlerDeps
      )
    ).toMatchObject({ ok: false });
    stopped.resolve({ success: false });
    expect(await cancelled).toMatchObject({ ok: true });
    expect(events.at(-1)?.properties).toMatchObject({ messageId: 'msg_1', status: 'cancelled' });
  });

  it.each(['commit', 'condense'] as const)(
    'reports %s failure against the admitted user message',
    async stage => {
      const events: SessionEventPayload[] = [];
      const handlerDeps = deps({
        runAutoCommit: async () => ({ success: false }),
        kiloClient: fakeKilo({ summarizeSession: async () => false }),
        emitSessionEvent: (_session, event) => events.push(event),
      });
      const finalization = stage === 'commit' ? { autoCommit: true } : { condenseOnComplete: true };
      expect(
        await handleControlRequest(
          'session.prompt',
          session,
          { ...promptPayload, finalization },
          handlerDeps
        )
      ).toMatchObject({ ok: true });
      await waitForTasks(handlerDeps);
      expect(events.at(-1)?.properties).toEqual({
        messageId: 'msg_1',
        status: 'failed',
        reason: stage === 'commit' ? 'Auto-commit failed' : 'Context condensation failed',
      });
    }
  );

  it('keeps the original execution deadline armed while finalization is running', async () => {
    const timers = spyOn(globalThis, 'setTimeout');
    const committing = Promise.withResolvers<AbortSignal>();
    const stopped = Promise.withResolvers<{ success: boolean }>();
    const events: SessionEventPayload[] = [];
    const retired: string[] = [];
    const handlerDeps = deps({
      runAutoCommit: options => {
        if (!options.signal) throw new Error('Missing finalization signal');
        committing.resolve(options.signal);
        return stopped.promise;
      },
      emitSessionEvent: (_session, event) => events.push(event),
      retireRuntime: reason => {
        retired.push(reason);
        handlerDeps.kiloReady = false;
      },
    });
    try {
      await handleControlRequest(
        'session.prompt',
        session,
        { ...promptPayload, finalization: { autoCommit: true } },
        handlerDeps
      );
      const signal = await committing.promise;
      const deadline = timers.mock.calls.find(
        ([, ms]) => ms === SANDBOX_CONTROL_EXECUTION_TIMEOUT_MS
      )?.[0];
      if (typeof deadline !== 'function') throw new Error('Missing owned execution deadline');
      deadline();
      expect(signal.aborted).toBe(true);
      expect(handlerDeps.tasks.size).toBe(1);
      stopped.resolve({ success: false });
      await waitForTasks(handlerDeps);
      expect(retired).toEqual(['Execution exceeded the 60 minute limit']);
      expect(events.at(-1)?.properties).toEqual({
        messageId: 'msg_1',
        status: 'failed',
        reason: 'Execution exceeded the 60 minute limit',
      });
    } finally {
      stopped.resolve({ success: false });
      timers.mockRestore();
    }
  });

  it('does not finalize a failed Kilo turn even when the normal autoCommit default is enabled', async () => {
    let finalized = false;
    const events: SessionEventPayload[] = [];
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        sendPrompt: async () => completion({ name: 'UnknownError', data: { message: 'failed' } }),
      }),
      runAutoCommit: async () => {
        finalized = true;
        return { success: true };
      },
      emitSessionEvent: (_session, event) => events.push(event),
    });
    await handleControlRequest(
      'session.prompt',
      session,
      { ...promptPayload, finalization: { autoCommit: true } },
      handlerDeps
    );
    await waitForTasks(handlerDeps);
    expect(finalized).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.properties).toMatchObject({ messageId: 'msg_1', status: 'failed' });
  });

  it('runs compact through the completion-returning summarize API without waiting for a close event', async () => {
    const finished = Promise.withResolvers<boolean>();
    const events: SessionEventPayload[] = [];
    let commands = 0;
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        summarizeSession: options => {
          expect(options).toEqual({
            sessionId: session.kiloSessionId,
            directory: session.directory,
            signal: expect.any(AbortSignal),
            model: { providerID: 'kilo', modelID: promptPayload.agent.model },
          });
          return finished.promise;
        },
        sendCommand: async () => {
          commands += 1;
          return completion();
        },
      }),
      emitSessionEvent: (_session, event) => events.push(event),
    });
    const payload = {
      ...promptPayload,
      turn: { type: 'command', command: 'compact', arguments: '' },
    };
    expect(
      await handleControlRequest('session.prompt', session, payload, handlerDeps)
    ).toMatchObject({ ok: true, result: { status: 'accepted' } });
    expect(events.some(event => event.type === 'session.message.outcome')).toBe(false);
    finished.resolve(true);
    await waitForTasks(handlerDeps);
    expect(commands).toBe(0);
    expect(events.at(-1)?.properties).toEqual({ messageId: 'msg_1', status: 'completed' });
  });

  it('rejects compact without a model and reports an asynchronous summarize failure', async () => {
    const events: SessionEventPayload[] = [];
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        summarizeSession: async () => {
          throw new Error('HTTP 500');
        },
      }),
      emitSessionEvent: (_session, event) => events.push(event),
    });
    const payload = {
      ...promptPayload,
      turn: { type: 'command', command: 'compact', arguments: '' },
    };
    expect(
      await handleControlRequest(
        'session.prompt',
        session,
        { ...payload, agent: { mode: 'code' } },
        handlerDeps
      )
    ).toMatchObject({ ok: false, error: { code: 'protocol_error' } });
    expect(handlerDeps.tasks.size).toBe(0);
    expect(
      await handleControlRequest('session.prompt', session, payload, handlerDeps)
    ).toMatchObject({ ok: true });
    await waitForTasks(handlerDeps);
    expect(events.at(-1)?.properties).toEqual({
      messageId: 'msg_1',
      status: 'failed',
      reason: 'Context condensation failed',
    });
  });
});

describe('control cancellation and attachments', () => {
  it.each(['session.abort', 'session.detach'] as const)(
    'cancels a queued sibling with %s without overtaking active preparation',
    async operation => {
      const sibling = { ...session, sessionId: 'ses_sibling', kiloSessionId: 'kilo_sibling' };
      const next = { ...session, sessionId: 'ses_next', kiloSessionId: 'kilo_next' };
      const started = Promise.withResolvers<AbortSignal>();
      const siblingQueued = Promise.withResolvers<void>();
      const nextQueued = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
      const setupCommands: string[] = [];
      let markerWrites = 0;
      let cancellationSettled = false;
      const handlerDeps = deps({
        emitPreparing: event => {
          if (event.action !== 'attempt_started') return;
          if (event.attemptId === 'sibling') siblingQueued.resolve();
          if (event.attemptId === 'next') nextQueued.resolve();
        },
        applyAttach: (identity, payload, dependencies) =>
          applySessionAttach(identity, payload, {
            ...dependencies,
            mkdir: async () => {},
            hasBootstrapMarker: async () => false,
            writeBootstrapMarker: async () => {
              markerWrites += 1;
            },
            sessionExists: async () => true,
            runSetup: async (command, _directory, _env, _output, signal) => {
              setupCommands.push(command);
              if (command === 'first') {
                if (!signal) throw new Error('Expected preparation signal');
                started.resolve(signal);
                return stopped.promise;
              }
              return { exitCode: 0, stdout: '', stderr: '' };
            },
          }),
      });
      const attaching: ReturnType<typeof handleControlRequest>[] = [];
      const attach = (identity: typeof session, command: string) => {
        const request = handleControlRequest(
          'session.attach',
          identity,
          {
            kilo,
            setupCommands: [command],
            preparation: { attemptId: command, triggerMessageId: command },
          },
          handlerDeps
        );
        attaching.push(request);
        return request;
      };
      const firstAttach = attach(session, 'first');
      let cancellingFirst: ReturnType<typeof handleControlRequest> | undefined;
      try {
        const signal = await started.promise;
        const siblingAttach = attach(sibling, 'sibling');
        await siblingQueued.promise;
        const cancelled = await withTimeoutAndAbort(
          handleControlRequest(
            operation,
            sibling,
            operation === 'session.abort' ? { messageId: 'sibling' } : {},
            handlerDeps
          ),
          {
            timeoutMs: 1_000,
            timeoutMessage: 'Queued sibling cancellation waited for active preparation',
            abortMessage: 'Test cancelled',
          }
        );
        expect(cancelled).toMatchObject({ ok: true });
        expect(await siblingAttach).toMatchObject({ ok: false });
        expect(handlerDeps.tasks.has(sibling.kiloSessionId)).toBe(false);
        expect(signal.aborted).toBe(false);
        expect(buildHeartbeatPayload(handlerDeps).activeKiloSessions).toBe(1);

        const nextAttach = attach(next, 'next');
        await nextQueued.promise;
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(setupCommands).toEqual(['first']);
        cancellingFirst = handleControlRequest(
          'session.abort',
          session,
          { messageId: 'first' },
          handlerDeps
        ).then(result => {
          cancellationSettled = true;
          return result;
        });
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(signal.aborted).toBe(true);
        expect(cancellationSettled).toBe(false);
        expect(handlerDeps.tasks.has(session.kiloSessionId)).toBe(true);
        expect(setupCommands).toEqual(['first']);

        stopped.resolve({ exitCode: 0, stdout: '', stderr: '' });
        expect(await cancellingFirst).toMatchObject({ ok: true });
        expect(await firstAttach).toMatchObject({ ok: false });
        expect(await nextAttach).toEqual({ ok: true, result: { attached: true } });
        expect(setupCommands).toEqual(['first', 'next']);
        expect(markerWrites).toBe(1);
      } finally {
        const cancelled = cancelControlTasks(handlerDeps, 'Test cleanup');
        stopped.resolve({ exitCode: 0, stdout: '', stderr: '' });
        await Promise.allSettled([...attaching, cancellingFirst, cancelled]);
      }
    }
  );

  it.each(['preparation', 'execution'])(
    'cancels owned %s before detaching its terminal',
    async phase => {
      const started = Promise.withResolvers<void>();
      let workSignal: AbortSignal | undefined;
      let detached = false;
      const running = Promise.withResolvers<Completion>();
      const handlerDeps = deps({
        kiloClient: fakeKilo({
          sendCommand: opts => {
            workSignal = opts.signal;
            started.resolve();
            return running.promise;
          },
        }),
        applyAttach: (identity, payload, dependencies) =>
          applySessionAttach(identity, payload, {
            ...dependencies,
            hasBootstrapMarker: async () => false,
            sessionExists: (_id, _directory, signal) => {
              workSignal = signal;
              started.resolve();
              return new Promise<boolean>(() => {});
            },
          }),
        terminalRuntime: fakeTerminalRuntime({
          detachSession: async () => {
            expect(workSignal?.aborted).toBe(true);
            expect(handlerDeps.tasks.size).toBe(0);
            detached = true;
          },
        }),
      });
      const admission =
        phase === 'preparation'
          ? handleControlRequest('session.attach', session, { kilo }, handlerDeps)
          : handleControlRequest(
              'session.prompt',
              session,
              { ...promptPayload, turn: { type: 'command', command: 'review', arguments: '' } },
              handlerDeps
            );
      await started.promise;
      expect(await handleControlRequest('session.detach', session, {}, handlerDeps)).toEqual({
        ok: true,
        result: { detached: true },
      });
      await admission;
      expect(detached).toBe(true);
      running.resolve(completion());
    }
  );

  it('shuts down pending preparation and execution together before completing shutdown', async () => {
    const preparing = Promise.withResolvers<void>();
    const running = Promise.withResolvers<Completion>();
    const signals: AbortSignal[] = [];
    const secondSession = {
      ...session,
      sessionId: 'ses_2',
      kiloSessionId: 'kilo_2',
      directory: '/workspace/second',
    };
    let terminalStopped = false;
    const handlerDeps = deps({
      applyAttach: (identity, payload, dependencies) =>
        applySessionAttach(identity, payload, {
          ...dependencies,
          hasBootstrapMarker: async () => false,
          sessionExists: (_id, _directory, signal) => {
            signals.push(signal);
            preparing.resolve();
            return new Promise<boolean>(() => {});
          },
        }),
      onShutdown: () => {
        handlerDeps.kiloReady = false;
      },
      terminalRuntime: fakeTerminalRuntime({
        shutdown: () => {
          expect(handlerDeps.tasks.size).toBe(0);
          terminalStopped = true;
        },
      }),
    });
    const runtimes = handlerDeps.kiloRuntimes;
    const firstRuntime = runtimes?.get(session.directory);
    if (!runtimes || !firstRuntime) throw new Error('Expected preparation runtime');
    const secondDeps = deps(
      {
        kiloClient: fakeKilo({
          sendCommand: opts => {
            if (opts.signal) signals.push(opts.signal);
            return running.promise;
          },
        }),
      },
      secondSession
    );
    expect(
      await handleControlRequest('session.attach', secondSession, { kilo }, secondDeps)
    ).toEqual({
      ok: true,
      result: { attached: true },
    });
    const secondRuntime = secondDeps.kiloRuntimes?.get(secondSession.directory);
    if (!secondRuntime) throw new Error('Expected execution runtime');
    runtimes.get = directory =>
      directory === session.directory
        ? firstRuntime
        : directory === secondSession.directory
          ? secondRuntime
          : undefined;
    const attaching = handleControlRequest('session.attach', session, { kilo }, handlerDeps);
    await preparing.promise;
    expect(
      await handleControlRequest(
        'session.prompt',
        secondSession,
        { ...promptPayload, turn: { type: 'command', command: 'review', arguments: '' } },
        handlerDeps
      )
    ).toEqual({ ok: true, result: { messageId: promptPayload.messageId, status: 'accepted' } });
    expect(handlerDeps.tasks.size).toBe(2);
    expect(await handleControlRequest('sandbox.shutdown', undefined, {}, handlerDeps)).toEqual({
      ok: true,
      result: { shuttingDown: true },
    });
    expect(await attaching).toMatchObject({ ok: false });
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(terminalStopped).toBe(true);
    expect(
      await handleControlRequest('session.attach', session, { kilo }, handlerDeps)
    ).toMatchObject({
      ok: false,
    });
    running.resolve(completion());
  });

  it('keeps a timed-out attach fenced until its mutating phase has quiesced', async () => {
    const timers = spyOn(globalThis, 'setTimeout');
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
    let markerWritten = false;
    const retired: string[] = [];
    const handlerDeps = deps({
      retireRuntime: reason => {
        retired.push(reason);
        handlerDeps.kiloReady = false;
      },
      applyAttach: (identity, payload, dependencies) =>
        applySessionAttach(identity, payload, {
          ...dependencies,
          mkdir: async () => {},
          hasBootstrapMarker: async () => false,
          writeBootstrapMarker: async () => {
            markerWritten = true;
          },
          sessionExists: async () => true,
          runSetup: (_command, _directory, _env, _output, signal) => {
            signal?.addEventListener('abort', () => cancelled.resolve(), { once: true });
            started.resolve();
            return stopped.promise;
          },
        }),
    });
    try {
      const attaching = handleControlRequest(
        'session.attach',
        session,
        { kilo, setupCommands: ['setup'] },
        handlerDeps
      );
      await started.promise;
      const deadline = timers.mock.calls.find(
        ([, ms]) => ms === SANDBOX_CONTROL_ATTACH_TIMEOUT_MS
      )?.[0];
      if (typeof deadline !== 'function') throw new Error('missing attachment deadline');
      deadline();
      await cancelled.promise;
      expect(
        await handleControlRequest('session.attach', session, { kilo }, handlerDeps)
      ).toMatchObject({
        ok: false,
      });
      expect(handlerDeps.tasks.size).toBe(1);
      stopped.resolve({ exitCode: 0, stdout: '', stderr: '' });
      expect(await attaching).toMatchObject({ ok: false });
      expect(markerWritten).toBe(false);
      expect(handlerDeps.tasks.size).toBe(0);
      expect(retired).toEqual(['Session preparation timed out']);
      expect(buildHeartbeatPayload(handlerDeps).kilo.ready).toBe(false);
      expect(
        await handleControlRequest('session.attach', session, { kilo }, handlerDeps)
      ).toMatchObject({
        ok: false,
      });
    } finally {
      stopped.resolve({ exitCode: 0, stdout: '', stderr: '' });
      timers.mockRestore();
    }
  });

  it('advertises preparation before setup starts and waits for process quiescence before retry', async () => {
    const started = Promise.withResolvers<void>();
    const calls: string[] = [];
    let quiesced = false;
    const handlerDeps = deps({
      applyAttach: (identity, payload, dependencies) =>
        applySessionAttach(identity, payload, {
          ...dependencies,
          mkdir: async () => {},
          hasBootstrapMarker: async () => false,
          writeBootstrapMarker: async () => {
            calls.push('marker');
          },
          sessionExists: async () => true,
          runSetup: async (command, _directory, _env, _output, signal) => {
            calls.push(command);
            const result = await runProcess(
              process.execPath,
              ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'],
              {
                cwd: os.tmpdir(),
                signal,
                onOutput: (_stream, output) => {
                  if (output.includes('ready')) started.resolve();
                },
              }
            );
            quiesced = true;
            return result;
          },
        }),
    });
    const payload = {
      kilo,
      setupCommands: ['first', 'second'],
      preparation: { attemptId: 'attempt_1', triggerMessageId: 'msg_1' },
    };
    const attaching = handleControlRequest('session.attach', session, payload, handlerDeps);
    expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({
      state: 'active',
      pendingMessages: 1,
      sessions: [{ kiloSessionId: 'kilo_1', state: 'active', waitingOn: 'preparation' }],
    });
    await started.promise;
    expect(await handleControlRequest('session.sync', session, {}, handlerDeps)).toEqual({
      ok: true,
      result: { status: { type: 'busy' }, questions: [], permissions: [] },
    });
    const aborting = handleControlRequest(
      'session.abort',
      session,
      { messageId: 'msg_1' },
      handlerDeps
    );
    expect(
      await handleControlRequest('session.attach', session, { kilo }, handlerDeps)
    ).toMatchObject({
      ok: false,
    });
    expect(await aborting).toMatchObject({ ok: true });
    expect(await attaching).toMatchObject({ ok: false });
    expect(quiesced).toBe(true);
    expect(calls).toEqual(['first']);
    expect(
      await handleControlRequest('session.attach', session, { kilo }, handlerDeps)
    ).toMatchObject({
      ok: true,
    });
    expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({ state: 'idle', pendingMessages: 0 });
  });

  it('materializes an attachment-only prompt after admission and passes a local file to Kilo', async () => {
    const identity = { ...session, sessionId: `attachments-${crypto.randomUUID()}` };
    const directory = path.join('/tmp/attachments', identity.sessionId);
    const localPath = path.join(directory, 'image.png');
    const downloadStarted = Promise.withResolvers<void>();
    const download = Promise.withResolvers<Response>();
    const prompts: unknown[] = [];
    const handlerDeps = deps({
      materializeAttachments: (message, options) =>
        materializeMessageAttachments(message, {
          ...options,
          fetch: Object.assign(
            () => {
              downloadStarted.resolve();
              return download.promise;
            },
            { preconnect: fetch.preconnect }
          ),
        }),
      kiloClient: fakeKilo({
        sendPrompt: async opts => {
          prompts.push(opts);
          return completion();
        },
      }),
    });
    try {
      const accepted = await handleControlRequest(
        'session.prompt',
        identity,
        {
          ...promptPayload,
          turn: { type: 'prompt', prompt: '' },
          attachments: [
            {
              filename: 'image.png',
              mime: 'image/png',
              signedUrl: 'https://r2.example.test/signed',
              localPath,
            },
          ],
        },
        handlerDeps
      );
      expect(accepted).toMatchObject({ ok: true });
      await downloadStarted.promise;
      expect(prompts).toEqual([]);
      download.resolve(new Response('image bytes'));
      await waitForTasks(handlerDeps);
      expect(prompts).toEqual([
        expect.objectContaining({
          parts: [
            { type: 'file', mime: 'image/png', filename: 'image.png', url: `file://${localPath}` },
          ],
        }),
      ]);
      expect(fs.readFileSync(localPath, 'utf8')).toBe('image bytes');
    } finally {
      download.resolve(new Response('image bytes'));
      await waitForTasks(handlerDeps);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('cancels a blocked attachment stream and removes partial files without submitting to Kilo', async () => {
    const identity = { ...session, sessionId: `attachments-${crypto.randomUUID()}` };
    const directory = path.join('/tmp/attachments', identity.sessionId);
    const localPath = path.join(directory, 'blocked.txt');
    const reading = Promise.withResolvers<void>();
    let cancelled = false;
    let prompts = 0;
    const events: SessionEventPayload[] = [];
    const handlerDeps = deps({
      materializeAttachments: (message, options) =>
        materializeMessageAttachments(message, {
          ...options,
          fetch: Object.assign(
            async () =>
              new Response(
                new ReadableStream(
                  {
                    pull: () => {
                      reading.resolve();
                    },
                    cancel: () => {
                      cancelled = true;
                    },
                  },
                  { highWaterMark: 0 }
                )
              ),
            { preconnect: fetch.preconnect }
          ),
        }),
      kiloClient: fakeKilo({
        sendPrompt: async () => {
          prompts += 1;
          return completion();
        },
      }),
      emitSessionEvent: (_session, event) => events.push(event),
    });
    try {
      await handleControlRequest(
        'session.prompt',
        identity,
        {
          ...promptPayload,
          attachments: [
            {
              filename: 'blocked.txt',
              mime: 'text/plain',
              signedUrl: 'https://r2.example.test/signed',
              localPath,
            },
          ],
        },
        handlerDeps
      );
      await reading.promise;
      expect(fs.statSync(localPath).isFile()).toBe(true);
      expect(
        await handleControlRequest('session.abort', identity, { messageId: 'msg_1' }, handlerDeps)
      ).toMatchObject({ ok: true });
      expect(cancelled).toBe(true);
      expect(prompts).toBe(0);
      expect(events[0]?.properties).toMatchObject({ messageId: 'msg_1', status: 'cancelled' });
      expect(
        (() => {
          try {
            fs.statSync(localPath);
            return true;
          } catch {
            return false;
          }
        })()
      ).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects attachment path escapes before materialization', async () => {
    let materialized = false;
    const handlerDeps = deps({
      materializeAttachments: async message => {
        materialized = true;
        return message;
      },
    });
    for (const localPath of [
      '/etc/profile',
      '/tmp/attachments/ses_1/../../profile',
      '/tmp/attachments/other/file.txt',
    ]) {
      expect(
        await handleControlRequest(
          'session.prompt',
          session,
          {
            ...promptPayload,
            attachments: [
              {
                filename: 'file.txt',
                mime: 'text/plain',
                signedUrl: 'https://r2.example.test/signed',
                localPath,
              },
            ],
          },
          handlerDeps
        )
      ).toMatchObject({ ok: false, error: { code: 'protocol_error' } });
    }
    expect(materialized).toBe(false);
  });
});

describe('control interactions and sync', () => {
  const question = {
    id: 'question_1',
    sessionID: 'kilo_1',
    blocking: true,
    questions: [
      {
        header: 'Target',
        question: 'Which target?',
        multiple: true,
        custom: true,
        options: [{ label: 'Cloud', description: 'Hosted target' }],
      },
    ],
    tool: { messageID: 'assistant_1', callID: 'tool_1' },
  };
  const permission = {
    id: 'perm_1',
    sessionID: 'kilo_1',
    permission: 'skill-shell',
    patterns: ['*'],
    metadata: { requiresHuman: true },
    always: [],
    tool: { messageID: 'assistant_1', callID: 'tool_2' },
  };

  it('answers and rejects questions belonging to the target root or its cached child in a shared directory', async () => {
    rememberAttachedRoot('kilo_2', session.directory);
    rememberChildSession({ childId: 'child_1', parentId: 'kilo_1', directory: session.directory });
    const answered: unknown[] = [];
    const rejected: unknown[] = [];
    const lookups: unknown[] = [];
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        getQuestions: async (directory, signal) => {
          lookups.push({ directory, signal });
          return [
            { ...question, id: 'question_root', sessionID: 'kilo_1' },
            { ...question, id: 'question_child', sessionID: 'child_1' },
            { ...question, id: 'question_sibling', sessionID: 'kilo_2' },
          ];
        },
        answerQuestion: async (...args) => {
          answered.push(args);
          return true;
        },
        rejectQuestion: async (...args) => {
          rejected.push(args);
          return true;
        },
      }),
    });
    expect(
      await handleControlRequest(
        'session.question.resolve',
        session,
        { action: 'answer', questionId: 'question_root', answers: [['yes']] },
        handlerDeps
      )
    ).toEqual({ ok: true, result: { success: true } });
    expect(
      await handleControlRequest(
        'session.question.resolve',
        session,
        { action: 'reject', questionId: 'question_child' },
        handlerDeps
      )
    ).toEqual({ ok: true, result: { success: true } });
    expect(answered).toEqual([
      ['question_root', [['yes']], session.directory, expect.any(AbortSignal)],
    ]);
    expect(rejected).toEqual([['question_child', session.directory, expect.any(AbortSignal)]]);
    expect(lookups).toEqual([
      { directory: session.directory, signal: expect.any(AbortSignal) },
      { directory: session.directory, signal: expect.any(AbortSignal) },
    ]);
  });

  it('rejects globally valid sibling and unknown-lineage question IDs without resolving them', async () => {
    rememberAttachedRoot('kilo_2', session.directory);
    rememberChildSession({ childId: 'child_2', parentId: 'kilo_2', directory: session.directory });
    const resolved: string[] = [];
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        getQuestions: async () => [
          { ...question, id: 'question_sibling', sessionID: 'kilo_2', rootKiloSessionId: 'kilo_1' },
          {
            ...question,
            id: 'question_sibling_child',
            sessionID: 'child_2',
            rootKiloSessionId: 'kilo_1',
          },
          {
            ...question,
            id: 'question_unknown',
            sessionID: 'unmapped_child',
            rootKiloSessionId: 'kilo_1',
          },
        ],
        answerQuestion: async questionId => {
          resolved.push(questionId);
          return true;
        },
        rejectQuestion: async questionId => {
          resolved.push(questionId);
          return true;
        },
      }),
    });
    for (const questionId of [
      'question_sibling',
      'question_sibling_child',
      'question_unknown',
      'question_missing',
    ]) {
      for (const action of ['answer', 'reject']) {
        expect(
          await handleControlRequest(
            'session.question.resolve',
            session,
            { action, questionId, ...(action === 'answer' ? { answers: [['yes']] } : {}) },
            handlerDeps
          )
        ).toEqual({
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'Question is not pending for this session',
            retryable: false,
          },
        });
      }
    }
    expect(resolved).toEqual([]);
  });

  it('stamps verified child-question snapshots for reconnect without trusting sibling root claims', async () => {
    const syncSession = {
      sessionId: 'workspace_sync_a',
      kiloSessionId: 'kilo_sync_a',
      directory: '/workspace/shared',
    };
    rememberAttachedRoot('kilo_sync_a', syncSession.directory);
    rememberAttachedRoot('kilo_sync_b', syncSession.directory);
    rememberChildSession({
      childId: 'kilo_sync_child',
      parentId: 'kilo_sync_a',
      directory: syncSession.directory,
    });
    rememberChildSession({
      childId: 'kilo_sync_sibling_child',
      parentId: 'kilo_sync_b',
      directory: syncSession.directory,
    });
    const rootQuestion = { ...question, id: 'question_root', sessionID: 'kilo_sync_a' };
    const childQuestion = {
      ...question,
      id: 'question_child',
      sessionID: 'kilo_sync_child',
      rootKiloSessionId: 'kilo_sync_b',
    };
    const rootPermission = { ...permission, sessionID: 'kilo_sync_a' };
    const handlerDeps = deps(
      {
        kiloClient: fakeKilo({
          getSessionStatuses: async () => ({ kilo_sync_a: { type: 'busy' } }),
          getQuestions: async () => [
            rootQuestion,
            childQuestion,
            ...['kilo_sync_b', 'kilo_sync_sibling_child', 'unmapped_child'].map(sessionID => ({
              ...question,
              id: `question_${sessionID}`,
              sessionID,
              rootKiloSessionId: 'kilo_sync_a',
            })),
          ],
          getPermissions: async () => [
            rootPermission,
            { ...permission, id: 'permission_sibling', sessionID: 'kilo_sync_b' },
          ],
        }),
      },
      syncSession
    );

    const result = await handleControlRequest('session.sync', syncSession, {}, handlerDeps);
    expect(result).toEqual({
      ok: true,
      result: {
        status: { type: 'busy' },
        questions: [rootQuestion, { ...childQuestion, rootKiloSessionId: 'kilo_sync_a' }],
        permissions: [rootPermission],
      },
    });
    if (!result.ok) throw new Error('Expected successful synchronization');
    expect(sessionSyncResultSchema.safeParse(result.result).success).toBe(true);
    expect(childQuestion.rootKiloSessionId).toBe('kilo_sync_b');
  });

  it('syncs rooted child asks and answers them in their own directory without admitting sibling requests', async () => {
    const childDirectory = '/workspace/child';
    const childQuestion = { ...question, id: 'child_question', sessionID: 'child' };
    const childPermission = { ...permission, id: 'child_permission', sessionID: 'grandchild' };
    const siblingQuestion = { ...question, id: 'sibling_question', sessionID: 'sibling' };
    const siblingPermission = { ...permission, id: 'sibling_permission', sessionID: 'sibling' };
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    rememberChildSession({
      childId: 'child',
      parentId: session.kiloSessionId,
      directory: childDirectory,
    });
    rememberChildSession({ childId: 'grandchild', parentId: 'child', directory: childDirectory });
    rememberAttachedRoot('sibling', session.directory);
    const replies: unknown[] = [];
    const queried = new Set<string>();
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        getSessionStatuses: async (
          directory,
          signal
        ): ReturnType<WrapperKiloClient['getSessionStatuses']> => {
          expect(signal?.aborted).toBe(false);
          return directory === session.directory
            ? { kilo_1: { type: 'busy' }, sibling: { type: 'idle' } }
            : {};
        },
        getQuestions: async directory => {
          if (directory) queried.add(directory);
          return directory === childDirectory
            ? [childQuestion]
            : [question, siblingQuestion, { ...question, id: 'unmapped', sessionID: 'unmapped' }];
        },
        getPermissions: async directory => {
          if (directory) queried.add(directory);
          return directory === childDirectory ? [childPermission] : [permission, siblingPermission];
        },
        answerQuestion: async (...args) => {
          replies.push(args);
          return true;
        },
        rejectQuestion: async (...args) => {
          replies.push(args);
          return true;
        },
        answerPermission: async (...args) => {
          replies.push(args);
          return true;
        },
      }),
    });
    expect(await handleControlRequest('session.sync', session, {}, handlerDeps)).toEqual({
      ok: true,
      result: {
        status: { type: 'busy' },
        questions: [question, { ...childQuestion, rootKiloSessionId: session.kiloSessionId }],
        permissions: [permission, { ...childPermission, rootKiloSessionId: session.kiloSessionId }],
      },
    });
    expect(queried).toEqual(new Set([session.directory, childDirectory]));
    expect(
      await handleControlRequest(
        'session.question.resolve',
        session,
        { action: 'answer', questionId: 'child_question', answers: [['Cloud']] },
        handlerDeps
      )
    ).toMatchObject({ ok: true });
    expect(
      await handleControlRequest(
        'session.question.resolve',
        session,
        { action: 'reject', questionId: 'child_question' },
        handlerDeps
      )
    ).toMatchObject({ ok: true });
    expect(
      await handleControlRequest(
        'session.permission.resolve',
        session,
        { permissionId: 'child_permission', response: 'once' },
        handlerDeps
      )
    ).toMatchObject({ ok: true });
    expect(replies).toEqual([
      ['child_question', [['Cloud']], childDirectory, expect.any(AbortSignal)],
      ['child_question', childDirectory, expect.any(AbortSignal)],
      ['child_permission', 'once', undefined, true, childDirectory, expect.any(AbortSignal)],
    ]);
    expect(
      await handleControlRequest(
        'session.question.resolve',
        session,
        { action: 'answer', questionId: 'sibling_question', answers: [] },
        handlerDeps
      )
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(
      await handleControlRequest(
        'session.permission.resolve',
        session,
        { permissionId: 'sibling_permission', response: 'always' },
        handlerDeps
      )
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(
      await handleControlRequest(
        'session.question.resolve',
        session,
        { action: 'reject', questionId: 'unmapped' },
        handlerDeps
      )
    ).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    expect(replies).toHaveLength(3);
  });

  it('does not hide a failed child-directory read behind a successful root snapshot', async () => {
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    rememberChildSession({
      childId: 'child',
      parentId: session.kiloSessionId,
      directory: '/workspace/child',
    });
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        getPermissions: async directory => {
          if (directory === '/workspace/child') throw new Error('HTTP 500');
          return [permission];
        },
      }),
    });
    expect(await handleControlRequest('session.sync', session, {}, handlerDeps)).toMatchObject({
      ok: false,
    });
  });

  it('uses fresh directory-scoped reads and preserves the complete pending interaction shape', async () => {
    const directories: unknown[] = [];
    let calls = 0;
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        getSessionStatuses: async (directory, signal) => {
          directories.push(directory);
          expect(signal?.aborted).toBe(false);
          calls += 1;
          return { kilo_1: { type: 'retry', attempt: calls } };
        },
        getQuestions: async (directory, signal) => {
          directories.push(directory);
          expect(signal?.aborted).toBe(false);
          return [question, { ...question, sessionID: 'other' }];
        },
        getPermissions: async (directory, signal) => {
          directories.push(directory);
          expect(signal?.aborted).toBe(false);
          return [permission, { ...permission, sessionID: 'other' }];
        },
      }),
    });
    for (const attempt of [1, 2]) {
      expect(await handleControlRequest('session.sync', session, {}, handlerDeps)).toEqual({
        ok: true,
        result: {
          status: { type: 'retry', attempt },
          questions: [question],
          permissions: [permission],
        },
      });
    }
    expect(directories).toEqual(Array(6).fill(session.directory));
  });

  it('reports owned work as busy before Kilo status starts and never hides a failed read', async () => {
    const finished = Promise.withResolvers<Completion>();
    const handlerDeps = deps({ kiloClient: fakeKilo({ sendCommand: () => finished.promise }) });
    await handleControlRequest(
      'session.prompt',
      session,
      { ...promptPayload, turn: { type: 'command', command: 'review', arguments: '' } },
      handlerDeps
    );
    expect(await handleControlRequest('session.sync', session, {}, handlerDeps)).toEqual({
      ok: true,
      result: { status: { type: 'busy' }, questions: [], permissions: [] },
    });
    const runtime = handlerDeps.kiloRuntimes?.get(session.directory);
    if (!runtime) throw new Error('Expected worktree runtime');
    (runtime as { kiloClient: WrapperKiloClient }).kiloClient = fakeKilo({
      getQuestions: async () => {
        throw new Error('HTTP 500');
      },
    });
    expect(await handleControlRequest('session.sync', session, {}, handlerDeps)).toMatchObject({
      ok: false,
    });
    finished.resolve(completion());
    await waitForTasks(handlerDeps);
  });

  it('routes human replies to the attached directory and retains asks until Kilo confirms resolution', async () => {
    const calls: unknown[] = [];
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        answerPermission: async (...args) => {
          calls.push(args);
          return true;
        },
        answerQuestion: async (...args) => {
          calls.push(args);
          return true;
        },
        rejectQuestion: async (...args) => {
          calls.push(args);
          return true;
        },
        getPermissions: async () => [permission],
        getQuestions: async () => [question, { ...question, id: 'question_2' }],
      }),
    });
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    handlerDeps.sessions.push({
      kiloSessionId: session.kiloSessionId,
      lastActivityAt: Date.now(),
    });
    updateSessionSnapshots(
      { type: 'permission.asked', properties: permission },
      handlerDeps.sessions
    );
    expect(
      await handleControlRequest(
        'session.permission.resolve',
        session,
        { permissionId: 'perm_1', response: 'once', message: 'Approved' },
        handlerDeps
      )
    ).toMatchObject({ ok: true });
    expect(
      await handleControlRequest(
        'session.question.resolve',
        session,
        { action: 'answer', questionId: 'question_1', answers: [['Cloud']] },
        handlerDeps
      )
    ).toMatchObject({ ok: true });
    expect(
      await handleControlRequest(
        'session.question.resolve',
        session,
        { action: 'reject', questionId: 'question_2' },
        handlerDeps
      )
    ).toMatchObject({ ok: true });
    expect(calls).toEqual([
      ['perm_1', 'once', 'Approved', true, session.directory, expect.any(AbortSignal)],
      ['question_1', [['Cloud']], session.directory, expect.any(AbortSignal)],
      ['question_2', session.directory, expect.any(AbortSignal)],
    ]);
    expect(handlerDeps.sessions[0]?.pendingInputs).toEqual(new Set(['perm_1']));
    expect(await handleControlRequest('session.sync', session, {}, handlerDeps)).toMatchObject({
      ok: true,
      result: { permissions: [permission] },
    });
  });

  it('returns failures for rejected interaction requests instead of reporting success', async () => {
    const handlerDeps = deps({
      kiloClient: fakeKilo({
        getPermissions: async () => [permission],
        getQuestions: async () => [question],
        answerPermission: async () => false,
        answerQuestion: async () => {
          throw new Error('HTTP 500');
        },
        rejectQuestion: async () => false,
      }),
    });
    expect(
      await handleControlRequest(
        'session.permission.resolve',
        session,
        { permissionId: 'perm_1', response: 'once' },
        handlerDeps
      )
    ).toMatchObject({ ok: false });
    expect(
      await handleControlRequest(
        'session.question.resolve',
        session,
        { action: 'answer', questionId: 'question_1', answers: [] },
        handlerDeps
      )
    ).toMatchObject({ ok: false });
    expect(
      await handleControlRequest(
        'session.question.resolve',
        session,
        { action: 'reject', questionId: 'question_1' },
        handlerDeps
      )
    ).toMatchObject({ ok: false });
  });
});

describe('control wrapper heartbeat source policy', () => {
  const source = fs
    .readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
    .replace(/\s+/g, ' ');

  it('carries only the typed diagnostic code on final and in-flight negative heartbeats', () => {
    expect(source).toContain(
      "diagnosticReason: NonNullable<SandboxHeartbeatPayload['kilo']['reason']> = 'shutdown'"
    );
    expect(source).toContain(
      'onUnexpectedClose: failure => shutdown( 1, `Kilo worktree failed reason=${failure.reason} directory=${failure.directory}`, failure.reason )'
    );
    expect(source).toContain(
      "onDisconnected: () => shutdown(1, 'Sandbox control connection lost', 'control_disconnected')"
    );
    expect(source).toContain(
      'if (!payload.kilo.ready && heartbeatReason) payload.kilo.reason = heartbeatReason;'
    );
    expect(source).toContain(
      'getHeartbeatPayload: async () => withHeartbeatReason(await refreshHeartbeatPayload(deps))'
    );
  });

  it('sets the first diagnostic before sending the final heartbeat and cancelling tasks', () => {
    const steps = [
      'if (shuttingDown) return;',
      'shuttingDown = true;',
      'heartbeatReason = diagnosticReason;',
      "control?.sendEvent?.('sandbox.heartbeat', withHeartbeatReason(buildHeartbeatPayload(deps)))",
      'cancelControlTasks(deps, reason,',
      'abort.abort();',
    ].map(step => source.indexOf(step));
    expect(steps.every(index => index >= 0)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });
});

describe('buildHeartbeatPayload', () => {
  it('synchronously includes advisory activity snapshots without polling Kilo', () => {
    let now = 100;
    const activity = createSessionActivityRegistry(() => now);
    activity.attach(session.kiloSessionId);
    activity.markActive(session.kiloSessionId);
    now = 150;
    let reads = 0;
    const handlerDeps = deps({
      activity,
      kiloClient: fakeKilo({
        getSessionStatuses: async () => {
          reads += 1;
          return {};
        },
      }),
    });

    expect(buildHeartbeatPayload(handlerDeps)).toEqual({
      state: 'active',
      activeKiloSessions: 1,
      pendingMessages: 0,
      kilo: { ready: true },
      sessions: [{ kiloSessionId: 'kilo_1', state: 'active', idleForMs: 50, waitingOn: 'model' }],
    });
    expect(reads).toBe(0);
  });

  it.each(['execution', 'finalizing'] as const)(
    'keeps owned %s authoritative over idle advisory status without settling the message',
    async phase => {
      const activity = createSessionActivityRegistry(() => 100);
      activity.attach(session.kiloSessionId);
      const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
      rememberAttachedRoot(sibling.kiloSessionId, sibling.directory);
      activity.attach(sibling.kiloSessionId);
      const running = Promise.withResolvers<Completion>();
      const finalizing = Promise.withResolvers<void>();
      const finalized = Promise.withResolvers<{ success: boolean }>();
      const events: SessionEventPayload[] = [];
      const handlerDeps = deps({
        activity,
        kiloClient: fakeKilo({
          sendPrompt: () => running.promise,
          getSessionStatuses: async () => ({ kilo_1: { type: 'idle' }, kilo_2: { type: 'idle' } }),
        }),
        runAutoCommit: () => {
          finalizing.resolve();
          return finalized.promise;
        },
        emitSessionEvent: (_identity, event) => events.push(event),
      });
      try {
        await handleControlRequest(
          'session.prompt',
          session,
          {
            ...promptPayload,
            ...(phase === 'finalizing' ? { finalization: { autoCommit: true } } : {}),
          },
          handlerDeps
        );
        if (phase === 'finalizing') {
          running.resolve(completion());
          await finalizing.promise;
        }
        const task = handlerDeps.tasks.get(session.kiloSessionId);
        expect(task?.kind).toBe(phase);
        expect(await refreshHeartbeatPayload(handlerDeps)).toMatchObject({
          state: phase === 'finalizing' ? 'finalizing' : 'active',
          activeKiloSessions: 1,
          pendingMessages: 1,
          sessions: [
            {
              kiloSessionId: 'kilo_1',
              state: phase === 'finalizing' ? 'finalizing' : 'active',
              waitingOn: phase === 'finalizing' ? 'finalizing' : 'model',
            },
            { kiloSessionId: 'kilo_2', state: 'idle' },
          ],
        });
        expect(activity.snapshots().every(snapshot => snapshot.state === 'idle')).toBe(true);
        expect(handlerDeps.tasks.get(session.kiloSessionId)).toBe(task);
        expect(events).toEqual([]);
        running.resolve(completion());
        finalized.resolve({ success: true });
        await waitForTasks(handlerDeps);
        expect(events).toEqual([
          {
            type: 'session.message.outcome',
            properties: { messageId: 'msg_1', status: 'completed' },
          },
        ]);
        expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({
          state: 'idle',
          activeKiloSessions: 0,
          pendingMessages: 0,
        });
      } finally {
        running.resolve(completion());
        finalized.resolve({ success: true });
        await waitForTasks(handlerDeps);
      }
    }
  );

  it('ages owned input waits without treating content silence as runtime death', async () => {
    const finished = Promise.withResolvers<Completion>();
    const handlerDeps = deps({ kiloClient: fakeKilo({ sendCommand: () => finished.promise }) });
    setSystemTime(1_000);
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    await handleControlRequest(
      'session.prompt',
      session,
      {
        ...promptPayload,
        turn: { type: 'command', command: 'review', arguments: '' },
      },
      handlerDeps
    );
    updateSessionSnapshots(
      {
        type: 'question.asked',
        properties: { sessionID: session.kiloSessionId, id: 'question_1' },
      },
      handlerDeps.sessions
    );
    setSystemTime(120_000);
    expect(buildHeartbeatPayload(handlerDeps)).toEqual({
      state: 'active',
      activeKiloSessions: 1,
      pendingMessages: 1,
      kilo: { ready: true },
      sessions: [
        { kiloSessionId: 'kilo_1', state: 'active', idleForMs: 119_000, waitingOn: 'input' },
      ],
    });
    finished.resolve(completion());
    await waitForTasks(handlerDeps);
    updateSessionSnapshots(
      {
        type: 'session.status',
        properties: { sessionID: session.kiloSessionId, status: { type: 'busy' } },
      },
      handlerDeps.sessions
    );
    expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({
      state: 'idle',
      activeKiloSessions: 0,
      pendingMessages: 0,
    });
  });

  describe('Dreamy: directory barrier and activity registry', () => {
    it('rejects session operations when directory is being deleted', async () => {
      await fenceDirectoryOperations(session.directory);
      const result = await handleControlRequest('session.prompt', session, promptPayload, deps());
      expect(result).toMatchObject({ ok: false, error: { message: 'Worktree is being deleted' } });
    });

    it('registers and detaches activity on attach/detach cycle', async () => {
      const activity = createSessionActivityRegistry(() => 100);
      const handlerDeps = deps({ activity });

      expect(
        await handleControlRequest('session.attach', session, { kilo }, handlerDeps)
      ).toMatchObject({ ok: true });
      expect(activity.snapshots()).toEqual([
        { kiloSessionId: 'kilo_1', state: 'idle', idleForMs: 0 },
      ]);

      expect(await handleControlRequest('session.detach', session, {}, handlerDeps)).toMatchObject({
        ok: true,
      });
      expect(activity.snapshots()).toEqual([]);
    });

    it('createSessionActivityRegistry: observeEvent transitions idle→active→idle', () => {
      const activity = createSessionActivityRegistry(() => 100);
      activity.attach('root_1');
      expect(activity.state()).toBe('idle');

      activity.observeEvent('session.turn.open', 'root_1', 'root_1', {});
      expect(activity.state()).toBe('active');

      activity.observeEvent('session.idle', 'root_1', 'root_1', {});
      expect(activity.state()).toBe('idle');
    });

    it('createSessionActivityRegistry: ignores events for non-root sessions', () => {
      const activity = createSessionActivityRegistry(() => 100);
      activity.attach('root_1');
      activity.observeEvent('session.turn.open', 'child_1', 'root_1', {});
      expect(activity.state()).toBe('idle');
    });

    it('createSessionActivityRegistry: reconcile resets tracked sessions', () => {
      const activity = createSessionActivityRegistry(() => 100);
      activity.attach('root_1');
      activity.markActive('root_1');
      expect(activity.state()).toBe('active');
      activity.reconcile({ root_1: { type: 'idle' } });
      expect(activity.state()).toBe('idle');
    });
  });
});

describe('refreshHeartbeatPayload', () => {
  it('does not reactivate a completed owned task from a stale busy status poll', async () => {
    const activity = createSessionActivityRegistry(() => 100);
    activity.attach(session.kiloSessionId);
    const finished = Promise.withResolvers<Completion>();
    const polling = Promise.withResolvers<void>();
    const statuses =
      Promise.withResolvers<Awaited<ReturnType<WrapperKiloClient['getSessionStatuses']>>>();
    const events: SessionEventPayload[] = [];
    const handlerDeps = deps({
      activity,
      kiloClient: fakeKilo({
        sendCommand: () => finished.promise,
        getSessionStatuses: () => {
          polling.resolve();
          return statuses.promise;
        },
      }),
      emitSessionEvent: (_identity, event) => events.push(event),
    });
    let refresh: ReturnType<typeof refreshHeartbeatPayload> | undefined;
    try {
      expect(
        await handleControlRequest(
          'session.prompt',
          session,
          {
            ...promptPayload,
            turn: { type: 'command', command: 'review', arguments: '' },
          },
          handlerDeps
        )
      ).toMatchObject({ ok: true, result: { status: 'accepted' } });
      activity.observeEvent('session.idle', session.kiloSessionId, session.kiloSessionId, {});
      refresh = refreshHeartbeatPayload(handlerDeps);
      await polling.promise;
      expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({
        state: 'active',
        pendingMessages: 1,
      });
      expect(events).toEqual([]);
      finished.resolve(completion());
      await waitForTasks(handlerDeps);
      expect(buildHeartbeatPayload(handlerDeps)).toMatchObject({
        state: 'idle',
        pendingMessages: 0,
      });
      statuses.resolve({ [session.kiloSessionId]: { type: 'busy' } });
      expect(await refresh).toEqual({
        state: 'idle',
        activeKiloSessions: 0,
        pendingMessages: 0,
        kilo: { ready: true },
        sessions: [{ kiloSessionId: session.kiloSessionId, state: 'idle', idleForMs: 0 }],
      });
      expect(handlerDeps.tasks.size).toBe(0);
      expect(events).toEqual([
        {
          type: 'session.message.outcome',
          properties: { messageId: 'msg_1', status: 'completed' },
        },
      ]);
    } finally {
      finished.resolve(completion());
      statuses.resolve({});
      await refresh;
      await waitForTasks(handlerDeps);
    }
  });

  it('ignores a detached root stale poll for its same-runtime replacement while updating its unchanged sibling', async () => {
    const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
    const activity = createSessionActivityRegistry(() => 100);
    const polling = Promise.withResolvers<void>();
    const statuses =
      Promise.withResolvers<Awaited<ReturnType<WrapperKiloClient['getSessionStatuses']>>>();
    const handlerDeps = deps({
      activity,
      kiloClient: fakeKilo({
        getSessionStatuses: () => {
          polling.resolve();
          return statuses.promise;
        },
      }),
    });
    for (const identity of [session, sibling]) {
      expect(await handleControlRequest('session.attach', identity, { kilo }, handlerDeps)).toEqual(
        {
          ok: true,
          result: { attached: true },
        }
      );
    }
    const runtime = handlerDeps.kiloRuntimes?.get(session.directory);
    expect(runtime).toBeDefined();
    const refresh = refreshHeartbeatPayload(handlerDeps);
    try {
      await polling.promise;
      expect(await handleControlRequest('session.detach', session, {}, handlerDeps)).toEqual({
        ok: true,
        result: { detached: true },
      });
      expect(await handleControlRequest('session.attach', session, { kilo }, handlerDeps)).toEqual({
        ok: true,
        result: { attached: true },
      });
      activity.attach(sibling.kiloSessionId);
      expect(handlerDeps.kiloRuntimes?.get(session.directory)).toBe(runtime);
      statuses.resolve({ kilo_1: { type: 'busy' }, kilo_2: { type: 'busy', waitingOn: 'tool' } });
      expect(await refresh).toEqual({
        state: 'active',
        activeKiloSessions: 1,
        pendingMessages: 0,
        kilo: { ready: true },
        sessions: [
          {
            kiloSessionId: sibling.kiloSessionId,
            state: 'active',
            idleForMs: 0,
            waitingOn: 'tool',
          },
          { kiloSessionId: session.kiloSessionId, state: 'idle', idleForMs: 0 },
        ],
      });
      expect(handlerDeps.tasks.size).toBe(0);
    } finally {
      statuses.resolve({});
      await refresh;
    }
  });

  it('reconciles attached roots in a shared directory with exactly one status read per heartbeat', async () => {
    let now = 100;
    const activity = createSessionActivityRegistry(() => now);
    const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
    const reads: unknown[] = [];
    const handlerDeps = deps({
      activity,
      kiloClient: fakeKilo({
        getSessionStatuses: async (
          directory,
          signal
        ): ReturnType<WrapperKiloClient['getSessionStatuses']> => {
          reads.push(directory);
          expect(signal?.aborted).toBe(false);
          return directory === session.directory
            ? { kilo_1: { type: 'idle' }, kilo_2: { type: 'busy' } }
            : {};
        },
      }),
    });
    for (const identity of [session, sibling]) {
      expect(
        (await handleControlRequest('session.attach', identity, { kilo }, handlerDeps)).ok
      ).toBe(true);
    }
    now = 150;

    const payload = await refreshHeartbeatPayload(handlerDeps);
    expect(reads).toEqual([session.directory]);
    expect(payload.state).toBe('active');
    expect(payload.sessions).toEqual([
      { kiloSessionId: 'kilo_1', state: 'idle', idleForMs: 50 },
      { kiloSessionId: 'kilo_2', state: 'active', idleForMs: 0, waitingOn: 'model' },
    ]);
    expect(payload).toEqual(buildHeartbeatPayload(handlerDeps));
    await refreshHeartbeatPayload(handlerDeps);
    expect(reads).toEqual([session.directory, session.directory]);
  });

  it('reconciles each attached worktree from its own directory-scoped statuses', async () => {
    let now = 100;
    const first = session;
    const second = { sessionId: 'ses_2', kiloSessionId: 'kilo_2', directory: '/workspace/second' };
    const activity = createSessionActivityRegistry(() => now);
    const handlerDeps = deps(
      {
        activity,
        kiloClient: fakeKilo({
          getSessionStatuses: async (
            directory,
            signal
          ): ReturnType<WrapperKiloClient['getSessionStatuses']> => {
            expect(signal?.aborted).toBe(false);
            return directory === first.directory
              ? { kilo_1: { type: 'busy', waitingOn: 'tool' } }
              : {};
          },
        }),
      },
      first
    );
    const otherDeps = deps(
      {
        activity,
        kiloClient: fakeKilo({
          getSessionStatuses: async (
            directory,
            signal
          ): ReturnType<WrapperKiloClient['getSessionStatuses']> => {
            expect(signal?.aborted).toBe(false);
            return directory === second.directory ? { kilo_2: { type: 'finalizing' } } : {};
          },
        }),
      },
      second
    );
    expect((await handleControlRequest('session.attach', first, { kilo }, handlerDeps)).ok).toBe(
      true
    );
    expect((await handleControlRequest('session.attach', second, { kilo }, otherDeps)).ok).toBe(
      true
    );
    const runtimes = handlerDeps.kiloRuntimes;
    const firstRuntime = runtimes?.get(first.directory);
    const secondRuntime = otherDeps.kiloRuntimes?.get(second.directory);
    if (!runtimes || !firstRuntime || !secondRuntime)
      throw new Error('Expected directory runtimes');
    runtimes.get = directory =>
      directory === first.directory
        ? firstRuntime
        : directory === second.directory
          ? secondRuntime
          : undefined;
    now = 150;

    const payload = await refreshHeartbeatPayload(handlerDeps);

    expect(payload.state).toBe('active');
    expect(payload.sessions).toEqual([
      { kiloSessionId: 'kilo_1', state: 'active', idleForMs: 0, waitingOn: 'tool' },
      { kiloSessionId: 'kilo_2', state: 'finalizing', idleForMs: 0, waitingOn: 'finalizing' },
    ]);
  });

  it('retains the previous active or finalizing state when its status read fails', async () => {
    let now = 100;
    const activity = createSessionActivityRegistry(() => now);
    const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
    const handlerDeps = deps({
      activity,
      kiloClient: fakeKilo({
        getSessionStatuses: async () => {
          throw new Error('status unavailable');
        },
      }),
    });
    expect((await handleControlRequest('session.attach', session, { kilo }, handlerDeps)).ok).toBe(
      true
    );
    expect((await handleControlRequest('session.attach', sibling, { kilo }, handlerDeps)).ok).toBe(
      true
    );
    activity.reconcile({ kilo_1: { type: 'busy' }, kilo_2: { type: 'finalizing' } }, [
      'kilo_1',
      'kilo_2',
    ]);
    now = 180;

    const payload = await refreshHeartbeatPayload(handlerDeps);

    expect(payload.state).toBe('active');
    expect(payload.pendingMessages).toBe(0);
    expect(payload.sessions).toEqual([
      { kiloSessionId: 'kilo_1', state: 'active', idleForMs: 80, waitingOn: 'model' },
      { kiloSessionId: 'kilo_2', state: 'finalizing', idleForMs: 80, waitingOn: 'finalizing' },
    ]);
  });

  it('preserves failed-directory activity while a successful empty poll idles only its own root', async () => {
    let now = 100;
    let failFirstDirectory = false;
    const first = session;
    const firstSibling = { ...first, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
    const second = {
      sessionId: 'ses_3',
      kiloSessionId: 'kilo_3',
      directory: '/workspace/second',
    };
    const activity = createSessionActivityRegistry(() => now);
    const handlerDeps = deps(
      {
        activity,
        kiloClient: fakeKilo({
          getSessionStatuses: async (
            directory,
            signal
          ): ReturnType<WrapperKiloClient['getSessionStatuses']> => {
            expect(signal?.aborted).toBe(false);
            if (directory !== first.directory) return {};
            if (failFirstDirectory) throw new Error('status unavailable');
            return { kilo_1: { type: 'busy', waitingOn: 'tool' }, kilo_2: { type: 'finalizing' } };
          },
        }),
      },
      first
    );
    const otherDeps = deps(
      {
        activity,
        kiloClient: fakeKilo({
          getSessionStatuses: async (
            directory,
            signal
          ): ReturnType<WrapperKiloClient['getSessionStatuses']> => {
            expect(signal?.aborted).toBe(false);
            return directory === second.directory && !failFirstDirectory
              ? { kilo_3: { type: 'busy' } }
              : {};
          },
        }),
      },
      second
    );
    for (const identity of [first, firstSibling]) {
      expect(
        (await handleControlRequest('session.attach', identity, { kilo }, handlerDeps)).ok
      ).toBe(true);
    }
    expect((await handleControlRequest('session.attach', second, { kilo }, otherDeps)).ok).toBe(
      true
    );
    const runtimes = handlerDeps.kiloRuntimes;
    const firstRuntime = runtimes?.get(first.directory);
    const secondRuntime = otherDeps.kiloRuntimes?.get(second.directory);
    if (!runtimes || !firstRuntime || !secondRuntime)
      throw new Error('Expected directory runtimes');
    runtimes.get = directory =>
      directory === first.directory
        ? firstRuntime
        : directory === second.directory
          ? secondRuntime
          : undefined;
    expect((await refreshHeartbeatPayload(handlerDeps)).sessions).toEqual([
      { kiloSessionId: 'kilo_1', state: 'active', idleForMs: 0, waitingOn: 'tool' },
      { kiloSessionId: 'kilo_2', state: 'finalizing', idleForMs: 0, waitingOn: 'finalizing' },
      { kiloSessionId: 'kilo_3', state: 'active', idleForMs: 0, waitingOn: 'model' },
    ]);
    now = 180;
    failFirstDirectory = true;

    const payload = await refreshHeartbeatPayload(handlerDeps);

    expect(payload.state).toBe('active');
    expect(payload.sessions).toEqual([
      { kiloSessionId: 'kilo_1', state: 'active', idleForMs: 80, waitingOn: 'tool' },
      { kiloSessionId: 'kilo_2', state: 'finalizing', idleForMs: 80, waitingOn: 'finalizing' },
      { kiloSessionId: 'kilo_3', state: 'idle', idleForMs: 0 },
    ]);
  });

  it('does not use a directoryless poll to idle a root without a directory mapping', async () => {
    let now = 100;
    let reads = 0;
    const activity = createSessionActivityRegistry(() => now);
    activity.attach('unmapped_root');
    activity.markActive('unmapped_root');
    now = 180;
    const handlerDeps = deps({
      activity,
      kiloClient: fakeKilo({
        getSessionStatuses: async () => {
          reads += 1;
          return {};
        },
      }),
    });

    const payload = await refreshHeartbeatPayload(handlerDeps);
    expect(payload.state).toBe('active');
    expect(payload.pendingMessages).toBe(0);
    expect(payload.sessions).toEqual([
      { kiloSessionId: 'unmapped_root', state: 'active', idleForMs: 80, waitingOn: 'model' },
    ]);
    expect(reads).toBe(0);
  });

  it.each([false, true])(
    'polls each matching directory client once and isolates reconciliation when one read fails: %s',
    async failFirst => {
      let now = 100;
      const activity = createSessionActivityRegistry(() => now);
      const other = { sessionId: 'ses_3', kiloSessionId: 'kilo_3', directory: '/workspace/other' };
      rememberAttachedRoot('kilo_2', session.directory);
      rememberAttachedRoot(other.kiloSessionId, other.directory);
      rememberChildSession({
        childId: 'child',
        parentId: session.kiloSessionId,
        directory: '/workspace/child',
      });
      for (const root of ['kilo_1', 'kilo_2', 'kilo_3']) activity.attach(root);
      activity.reconcile({
        kilo_1: { type: 'busy' },
        kilo_2: { type: 'finalizing' },
        kilo_3: { type: 'busy' },
      });
      now = 180;
      const reads: Array<{ client: string; directory: string | undefined }> = [];
      const handlerDeps = deps({
        activity,
        kiloClient: fakeKilo({
          getSessionStatuses: async (directory, signal) => {
            reads.push({ client: 'first', directory });
            expect(signal?.aborted).toBe(false);
            if (failFirst) throw new Error('first directory unavailable');
            return {
              kilo_1: { type: 'busy', waitingOn: 'tool' },
              kilo_3: { type: 'busy' },
              child: { type: 'busy' },
            };
          },
        }),
      });
      const otherDeps = deps(
        {
          kiloClient: fakeKilo({
            getSessionStatuses: async (directory, signal) => {
              reads.push({ client: 'other', directory });
              expect(signal?.aborted).toBe(false);
              return { kilo_1: { type: 'idle' }, kilo_3: { type: 'idle' } };
            },
          }),
        },
        other
      );
      const runtimes = handlerDeps.kiloRuntimes;
      const firstRuntime = runtimes?.get(session.directory);
      const otherRuntime = otherDeps.kiloRuntimes?.get(other.directory);
      if (!runtimes || !firstRuntime || !otherRuntime)
        throw new Error('Expected directory runtimes');
      runtimes.get = directory =>
        directory === session.directory
          ? firstRuntime
          : directory === other.directory
            ? otherRuntime
            : undefined;

      const payload = await refreshHeartbeatPayload(handlerDeps);
      expect(reads).toHaveLength(2);
      expect(reads).toContainEqual({ client: 'first', directory: session.directory });
      expect(reads).toContainEqual({ client: 'other', directory: other.directory });
      expect(payload.sessions).toEqual([
        {
          kiloSessionId: 'kilo_1',
          state: 'active',
          idleForMs: failFirst ? 80 : 0,
          waitingOn: failFirst ? 'model' : 'tool',
        },
        failFirst
          ? { kiloSessionId: 'kilo_2', state: 'finalizing', idleForMs: 80, waitingOn: 'finalizing' }
          : { kiloSessionId: 'kilo_2', state: 'idle', idleForMs: 0 },
        { kiloSessionId: 'kilo_3', state: 'idle', idleForMs: 0 },
      ]);
      expect(payload.pendingMessages).toBe(0);
    }
  );

  it('bounds a hung status poll and retains advisory activity after its deadline', async () => {
    const activity = createSessionActivityRegistry(() => 100);
    activity.attach(session.kiloSessionId);
    activity.markActive(session.kiloSessionId);
    const started = Promise.withResolvers<AbortSignal>();
    const response =
      Promise.withResolvers<Awaited<ReturnType<WrapperKiloClient['getSessionStatuses']>>>();
    const handlerDeps = deps({
      activity,
      kiloClient: fakeKilo({
        getSessionStatuses: (_directory, signal) => {
          if (!signal) throw new Error('Expected status polling signal');
          started.resolve(signal);
          return response.promise;
        },
      }),
    });
    const timers = spyOn(globalThis, 'setTimeout');
    let refresh: ReturnType<typeof refreshHeartbeatPayload> | undefined;
    try {
      refresh = refreshHeartbeatPayload(handlerDeps);
      const signal = await started.promise;
      const deadline = timers.mock.calls.find(
        ([, ms]) => ms === KILO_CONTROL_REQUEST_TIMEOUT_MS
      )?.[0];
      if (typeof deadline !== 'function')
        throw new Error('Missing bounded status polling deadline');
      deadline();
      const payload = await refresh;
      expect(signal.aborted).toBe(true);
      expect(payload.sessions).toEqual([
        { kiloSessionId: 'kilo_1', state: 'active', idleForMs: 0, waitingOn: 'model' },
      ]);
      response.resolve({ kilo_1: { type: 'idle' } });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(buildHeartbeatPayload(handlerDeps).sessions).toEqual(payload.sessions);
    } finally {
      response.resolve({});
      await refresh;
      timers.mockRestore();
    }
  });
});

describe('createSessionActivityRegistry', () => {
  it('updates only exact root status and turn events while preserving true child events', () => {
    let now = 100;
    const activity = createSessionActivityRegistry(() => now);
    activity.attach('root_a');
    activity.attach('root_b');
    activity.markActive('root_a');
    now = 140;

    for (const type of ['session.idle', 'session.turn.close', 'session.error']) {
      activity.observeEvent(type, 'child_a', 'root_a', { sessionID: 'child_a' });
    }
    activity.observeEvent('session.status', 'child_a', 'root_a', {
      sessionID: 'child_a',
      status: { type: 'idle' },
    });
    expect(activity.snapshots()).toEqual([
      { kiloSessionId: 'root_a', state: 'active', idleForMs: 40, waitingOn: 'model' },
      { kiloSessionId: 'root_b', state: 'idle', idleForMs: 40 },
    ]);

    activity.observeEvent('session.status', 'root_b', 'root_b', {
      sessionID: 'root_b',
      status: { type: 'finalizing' },
    });
    activity.observeEvent('session.turn.close', 'root_a', 'root_a', { sessionID: 'root_a' });
    expect(activity.snapshots()).toEqual([
      { kiloSessionId: 'root_a', state: 'idle', idleForMs: 0 },
      { kiloSessionId: 'root_b', state: 'finalizing', idleForMs: 0, waitingOn: 'finalizing' },
    ]);
    expect(activity.state()).toBe('active');
  });

  it('does not reset an active root when its attach is replayed', () => {
    let now = 100;
    const activity = createSessionActivityRegistry(() => now);
    activity.attach('root');
    activity.markActive('root');
    now = 175;
    activity.attach('root');
    expect(activity.snapshots()).toEqual([
      { kiloSessionId: 'root', state: 'active', idleForMs: 75, waitingOn: 'model' },
    ]);
  });

  it('reconciles missing statuses as idle without letting child status settle its root', () => {
    const activity = createSessionActivityRegistry(() => 100);
    activity.attach('root_a');
    activity.attach('root_b');
    activity.markActive('root_a');
    activity.markActive('root_b');
    activity.reconcile({ root_a: { type: 'busy', waitingOn: 'tool' }, child_b: { type: 'busy' } }, [
      'root_a',
      'root_b',
    ]);
    expect(activity.snapshots()).toEqual([
      { kiloSessionId: 'root_a', state: 'active', idleForMs: 0, waitingOn: 'tool' },
      { kiloSessionId: 'root_b', state: 'idle', idleForMs: 0 },
    ]);
    expect(activity.state()).toBe('active');
  });

  it('limits status reconciliation to the supplied roots without settling other directories', () => {
    const activity = createSessionActivityRegistry(() => 100);
    activity.attach('root_a');
    activity.attach('root_b');
    activity.markActive('root_a');
    activity.markActive('root_b');
    activity.reconcile({ root_b: { type: 'idle' } }, ['root_a']);
    expect(activity.snapshots()).toEqual([
      { kiloSessionId: 'root_a', state: 'idle', idleForMs: 0 },
      { kiloSessionId: 'root_b', state: 'active', idleForMs: 0, waitingOn: 'model' },
    ]);
  });

  it('returns the sandbox to idle only after every active root settles or detaches', () => {
    const activity = createSessionActivityRegistry(() => 100);
    activity.attach('root_a');
    activity.attach('root_b');
    activity.observeEvent('session.turn.open', 'root_a', 'root_a', { sessionID: 'root_a' });
    activity.observeEvent('session.status', 'root_b', 'root_b', {
      sessionID: 'root_b',
      status: { type: 'retry' },
    });
    activity.observeEvent('session.error', 'root_a', 'root_a', { sessionID: 'root_a' });
    expect(activity.state()).toBe('active');
    activity.detach('root_b');
    expect(activity.state()).toBe('idle');
    expect(activity.snapshots()).toEqual([
      { kiloSessionId: 'root_a', state: 'idle', idleForMs: 0 },
    ]);
  });
});

describe('session.git.summary', () => {
  const captured: SessionGitSummaryResult = {
    revision: 1,
    comparison: {
      baseRef: 'refs/remotes/origin/main',
      mergeBase: 'a'.repeat(40),
      head: 'b'.repeat(40),
    },
    files: [],
    truncated: false,
  };

  beforeEach(() => {
    resetSessionDirectoryState();
  });

  it('allows each attached shared-worktree root without waking Kilo or changing activity', async () => {
    const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
    const activity = createSessionActivityRegistry(() => 100);
    const directories: string[] = [];
    for (const identity of [session, sibling]) {
      rememberAttachedRoot(identity.kiloSessionId, identity.directory);
      activity.attach(identity.kiloSessionId);
    }
    activity.markActive(session.kiloSessionId);
    const snapshots = activity.snapshots();
    const handlerDeps = deps({
      kiloClient: undefined,
      kiloReady: false,
      activity,
      collectWorktreeChanges: async directory => {
        directories.push(directory);
        return captured;
      },
    });

    expect(rootForSession(undefined, session.directory)).toBeUndefined();
    for (const identity of [session, sibling]) {
      expect(
        await handleControlRequest('session.git.summary', identity, { revision: 1 }, handlerDeps)
      ).toEqual({ ok: true, result: captured });
    }
    expect(directories).toEqual([session.directory, session.directory]);
    expect(activity.snapshots()).toEqual(snapshots);
    expect(handlerDeps.sessions).toEqual([]);
    expect(handlerDeps.tasks.size).toBe(0);
  });

  it('drains in-flight capture before deletion and rejects late results without fencing another worktree', async () => {
    const sibling = { sessionId: 'ses_2', kiloSessionId: 'kilo_2', directory: '/other' };
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    rememberAttachedRoot(sibling.kiloSessionId, sibling.directory);
    const started = Promise.withResolvers<void>();
    const capture = Promise.withResolvers<SessionGitSummaryResult>();
    const directories: string[] = [];
    const handlerDeps = deps({
      kiloClient: undefined,
      collectWorktreeChanges: async directory => {
        directories.push(directory);
        if (directory !== session.directory) return captured;
        started.resolve();
        return capture.promise;
      },
    });
    const request = handleControlRequest(
      'session.git.summary',
      session,
      { revision: 1 },
      handlerDeps
    );
    await started.promise;
    let fenced = false;
    const deletion = fenceDirectoryOperations(session.directory).then(() => {
      fenced = true;
    });
    try {
      await Promise.resolve();
      expect(fenced).toBe(false);
      expect(
        await handleControlRequest('session.git.summary', session, { revision: 2 }, handlerDeps)
      ).toEqual({
        ok: false,
        error: { code: 'not_ready', message: 'Worktree is being deleted', retryable: false },
      });
      expect(
        await handleControlRequest('session.git.summary', sibling, { revision: 1 }, handlerDeps)
      ).toEqual({ ok: true, result: captured });
      expect(directories).toEqual([session.directory, sibling.directory]);
      expect(fenced).toBe(false);
      capture.resolve(captured);
      expect(await request).toEqual({
        ok: false,
        error: { code: 'not_ready', message: 'Worktree is being deleted', retryable: false },
      });
      await deletion;
      expect(fenced).toBe(true);
      expect(handlerDeps.tasks.size).toBe(0);
      expect(handlerDeps.sessions).toEqual([]);
    } finally {
      capture.resolve(captured);
      await Promise.all([request, deletion]);
    }
  });

  it.each(['detached', 'moved', 'retired'] as const)(
    'rejects capture completed after its root is %s while preserving its sibling',
    async change => {
      const sibling = { ...session, sessionId: 'ses_2', kiloSessionId: 'kilo_2' };
      rememberAttachedRoot(session.kiloSessionId, session.directory);
      rememberAttachedRoot(sibling.kiloSessionId, sibling.directory);
      const abort = new AbortController();
      const started = Promise.withResolvers<AbortSignal | undefined>();
      const capture = Promise.withResolvers<SessionGitSummaryResult>();
      const handlerDeps = deps({
        kiloClient: undefined,
        signal: abort.signal,
        collectWorktreeChanges: async (_directory, _request, _runGit, signal) => {
          started.resolve(signal);
          return capture.promise;
        },
      });
      const request = handleControlRequest(
        'session.git.summary',
        session,
        { revision: 1 },
        handlerDeps
      );
      try {
        expect(await started.promise).toBe(abort.signal);
        if (change === 'detached') {
          expect(await handleControlRequest('session.detach', session, {}, handlerDeps)).toEqual({
            ok: true,
            result: { detached: true },
          });
        } else if (change === 'moved') {
          rememberAttachedRoot(session.kiloSessionId, '/moved');
        } else {
          abort.abort();
        }
        capture.resolve(captured);
        expect(await request).toEqual({
          ok: false,
          error:
            change === 'retired'
              ? { code: 'not_ready', message: 'Kilo is not ready', retryable: true }
              : {
                  code: 'not_ready',
                  message: 'Session directory is not attached',
                  retryable: false,
                },
        });
        expect(rootForSession(sibling.kiloSessionId, sibling.directory)).toBe(
          sibling.kiloSessionId
        );
        expect(handlerDeps.tasks.size).toBe(0);
      } finally {
        capture.resolve(captured);
        await request;
      }
    }
  );

  it('collects only from the attached root without calling Kilo or attaching anything', async () => {
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    const calls: unknown[] = [];
    const capture = {
      revision: 12,
      comparison: {
        baseRef: 'refs/remotes/origin/main',
        mergeBase: 'a'.repeat(40),
        head: 'b'.repeat(40),
      },
      files: [],
      truncated: false,
    };
    const payload = { revision: 12, baseRef: 'refs/remotes/origin/main' };
    const result = await handleControlRequest(
      'session.git.summary',
      session,
      payload,
      deps({
        kiloClient: undefined,
        kiloReady: false,
        collectWorktreeChanges: async (directory, request) => {
          calls.push({ directory, request });
          return capture;
        },
      })
    );
    expect(calls).toEqual([{ directory: session.directory, request: payload }]);
    expect(result).toEqual({ ok: true, result: capture });
  });

  it('requires the request envelope identity', async () => {
    const result = await handleControlRequest(
      'session.git.summary',
      undefined,
      { revision: 1 },
      deps()
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'session identity is required', retryable: false },
    });
  });

  it.each([
    'unattached',
    'directory-only',
    'wrong-directory',
    'child',
    'unknown-root',
    'detached-root',
  ])('rejects %s scope without running capture', async scope => {
    if (scope === 'directory-only')
      rememberSessionDirectory(session.kiloSessionId, session.directory);
    if (scope === 'wrong-directory') rememberAttachedRoot(session.kiloSessionId, '/other');
    if (scope === 'child') {
      rememberAttachedRoot('root', session.directory);
      rememberChildSession({
        childId: session.kiloSessionId,
        parentId: 'root',
        directory: session.directory,
      });
    }
    if (scope === 'unknown-root') rememberAttachedRoot('other', session.directory);
    if (scope === 'detached-root') {
      rememberAttachedRoot(session.kiloSessionId, session.directory);
      rememberAttachedRoot('replacement', session.directory);
      forgetAttachedRoot(session.kiloSessionId, session.directory);
    }
    let called = false;
    const result = await handleControlRequest(
      'session.git.summary',
      session,
      { revision: 1 },
      deps({
        collectWorktreeChanges: async () => {
          called = true;
          throw new Error('Must not run');
        },
      })
    );
    expect(called).toBe(false);
    expect(result).toEqual({
      ok: false,
      error: { code: 'not_ready', message: 'Session directory is not attached', retryable: false },
    });
  });

  it.each([
    { revision: 1, directory: '/outside' },
    { revision: 1, baseRef: '--help' },
    { revision: 0 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid payload %j without capture', async payload => {
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    let called = false;
    const result = await handleControlRequest(
      'session.git.summary',
      session,
      payload,
      deps({
        collectWorktreeChanges: async () => {
          called = true;
          throw new Error('Must not run');
        },
      })
    );
    expect(called).toBe(false);
    expect(result).toEqual({
      ok: false,
      error: { code: 'protocol_error', message: 'Invalid payload', retryable: false },
    });
  });

  it('returns a safe failure without exposing subprocess output or file data', async () => {
    rememberAttachedRoot(session.kiloSessionId, session.directory);
    const result = await handleControlRequest(
      'session.git.summary',
      session,
      { revision: 1 },
      deps({
        collectWorktreeChanges: async () => {
          throw new Error('private stdout, stderr, file contents, token');
        },
      })
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'capture_failed', message: 'Worktree capture failed', retryable: true },
    });
  });
});
