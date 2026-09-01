import { SELF, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallbackJob } from '../../src/callbacks/index.js';
import type { SessionMessageIntent } from '../../src/execution/types.js';
import { deriveKiloSandboxTargets } from '../../src/kilo/kilo-targets.js';
import { encodeCloudflareProviderRef } from '../../src/sandbox-control/cloudflare-provider.js';
import { createControlPlaneCredential } from '../../src/sandbox-control/managed-credential.js';
import { WORKTREE_CREDENTIAL_CONTAINMENT } from '../../src/sandbox-control/physical-lifecycle.js';
import { sessionCredentialGrantSchema } from '../../src/sandbox-control/session-credentials.js';
import { createMessageId } from '../../src/session/message-id.js';
import {
  generateSandboxCredential,
  hashSandboxCredential,
} from '../../src/sandbox-control/credential.js';
import { createMemoryProviderAdapter } from '../../src/sandbox-control/provider.js';
import type { SandboxSession } from '../../src/sandbox-session/SandboxSession.js';
import type { SessionMessageRecord } from '../../src/sandbox-session/session-message-queue.js';
import {
  SANDBOX_CONTROL_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  requestFrameSchema,
  sessionPromptPayloadSchema,
  type RequestFrame,
} from '../../src/shared/sandbox-control-protocol.js';
import { getSessionWorkspacePath, getWorktreeWorkspacePath } from '../../src/workspace.js';

const ownerId = 'user_control_owner' as const;
const kiloSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
const kiloToken = 'session-intent-fixture-kilo-token';
const attachments = {
  path: '123e4567-e89b-12d3-a456-426614174000',
  files: ['123e4567-e89b-12d3-a456-426614174001.pdf'],
};

type RegisterSessionInput = Parameters<SandboxSession['registerSession']>[0];

type SandboxResponses = {
  promptAccepted: boolean;
  sessionStatus: 'busy' | 'idle' | 'retry';
  syncRetryableFailure: boolean;
  questions: unknown[];
  permissions: unknown[];
};

function registration(
  sessionId: `workspace_${string}`,
  sandboxId: `ses-${string}`
): RegisterSessionInput {
  return {
    identity: { sessionId, userId: ownerId },
    auth: { kiloSessionId, kilocodeToken: kiloToken },
    agent: { mode: 'code', model: 'kilo/default-model', variant: 'balanced' },
    finalization: { autoCommit: true, condenseOnComplete: false },
    workspace: { sandboxId },
  };
}

function pauseDispatch(instance: SandboxSession): void {
  instance['dispatchQueued'] = async () => undefined;
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => {
      socket.removeEventListener('error', onError);
      resolve(typeof event.data === 'string' ? event.data : String(event.data));
    };
    const onError = () => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('sandbox control websocket error'));
    };
    socket.addEventListener('message', onMessage, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

async function connectReadySandbox(
  sandboxId: `ses-${string}`,
  sessionId: `workspace_${string}`
): Promise<{
  socket: WebSocket;
  wrapperInstanceId: string;
  requests: RequestFrame[];
  requestTimeouts: Array<{ messageId: string; timeoutMs?: number }>;
  responses: SandboxResponses;
}> {
  const credential = generateSandboxCredential();
  const wrapperInstanceId = crypto.randomUUID();
  const creationId = crypto.randomUUID();
  const providerInstanceId = encodeCloudflareProviderRef({
    sandboxId,
    containment: true,
    instanceId: creationId,
  });
  const targets = deriveKiloSandboxTargets({}, kiloToken);
  if (!targets.success) throw new Error('Invalid session intent fixture targets');
  const now = Date.now();
  const outboundContainerId = `contained-small:${sandboxId}`;
  const grant = sessionCredentialGrantSchema.parse({
    version: 1,
    scopeId: sessionId,
    sandboxId,
    directory: getSessionWorkspacePath(undefined, ownerId, sessionId),
    userId: ownerId,
    provider: 'cloudflare',
    outboundContainerId,
    members: [{ sessionId, kiloSessionId }],
    kilo: {
      alias: createControlPlaneCredential(sandboxId, 'kilo'),
      token: kiloToken,
      targets: targets.targets,
      capabilities: {
        [sessionId]: {
          credential: `kka1.${crypto.randomUUID()}`,
          outboundContainerId,
          issuedAt: now,
          expiresAt: now + 3 * 60 * 60 * 1000,
        },
      },
    },
    preparedAt: now,
    expiresAt: now + 4 * 60 * 60 * 1000,
  });
  const control = env.SANDBOX_CONTROL.getByName(sandboxId);
  const requestTimeouts: Array<{ messageId: string; timeoutMs?: number }> = [];
  const responses: SandboxResponses = {
    promptAccepted: true,
    sessionStatus: 'busy',
    syncRetryableFailure: false,
    questions: [],
    permissions: [],
  };
  await runInDurableObject(control, async (instance, state) => {
    const provider = createMemoryProviderAdapter();
    Object.assign(instance, {
      provider,
      createProviderAdapter: async () => provider,
      env: {
        ...env,
        KILOCODE_BACKEND_BASE_URL: targets.targets.backendBaseUrl,
        KILO_OPENROUTER_BASE: targets.targets.providerBaseUrl,
        KILO_SESSION_INGEST_URL: targets.targets.sessionIngestBaseUrl,
        SandboxSmallContainment: {
          idFromName: (name: string) => ({ toString: () => `contained-small:${name}` }),
        },
      },
    });
    const socketHandler = instance['socketHandler'];
    const sendRequest = socketHandler.sendRequest.bind(socketHandler);
    socketHandler.sendRequest = async input => {
      if (input.operation === 'session.attach' || input.operation === 'session.prompt') {
        expect(input.expectedWrapperInstanceId).toBe(wrapperInstanceId);
      }
      if (input.operation === 'session.prompt') {
        requestTimeouts.push({
          messageId: sessionPromptPayloadSchema.parse(input.payload).messageId,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        });
      }
      return sendRequest(input);
    };
    await instance.initializeOwner(ownerId);
    await instance.claimCreate(creationId, false, sandboxId, WORKTREE_CREDENTIAL_CONTAINMENT);
    await state.storage.put('worktree_credential_grants', [grant]);
    await instance.confirmInstance(providerInstanceId);
    await instance.setWrapperCredentialHash(await hashSandboxCredential(credential));
  });

  const response = await SELF.fetch(`http://worker.test/sandbox-control/${sandboxId}`, {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${credential}`,
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`Unexpected sandbox control upgrade: ${response.status}`);
  }
  const socket = response.webSocket;
  socket.accept();
  socket.send(
    JSON.stringify({
      type: 'request',
      requestId: 'hello-session-intent',
      operation: 'sandbox.hello',
      payload: { protocolVersion: 1, providerInstanceId, wrapperInstanceId },
    })
  );
  expect(JSON.parse(await nextMessage(socket))).toMatchObject({
    type: 'response',
    requestId: 'hello-session-intent',
    ok: true,
  });
  const status = requestFrameSchema.parse(JSON.parse(await nextMessage(socket)));
  expect(status.operation).toBe('sandbox.status');
  socket.send(
    JSON.stringify({
      type: 'response',
      requestId: status.requestId,
      ok: true,
      result: { healthy: true, state: 'idle', version: 'test', kiloReady: true },
    })
  );
  socket.send(
    JSON.stringify({
      type: 'event',
      event: 'sandbox.ready',
      payload: { kiloReady: true, globalFeedAttached: true },
    })
  );
  await vi.waitFor(async () => {
    const status = await runInDurableObject(control, instance => instance.getStatus());
    expect(status).toMatchObject({ connection: 'ready', physical: 'running', wrapperInstanceId });
  });

  const requests: RequestFrame[] = [];
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string') return;
    const frame = requestFrameSchema.safeParse(JSON.parse(event.data));
    if (!frame.success) return;
    requests.push(frame.data);
    if (
      (frame.data.operation === 'session.prompt' && !responses.promptAccepted) ||
      (frame.data.operation === 'session.sync' && responses.syncRetryableFailure)
    ) {
      socket.send(
        JSON.stringify({
          type: 'response',
          requestId: frame.data.requestId,
          ok: false,
          error: {
            code: 'not_ready',
            message: 'Operation temporarily unavailable',
            retryable: true,
          },
        })
      );
      return;
    }
    const result =
      frame.data.operation === 'session.attach'
        ? { attached: true }
        : frame.data.operation === 'session.sync'
          ? {
              status: { type: responses.sessionStatus },
              questions: responses.questions,
              permissions: responses.permissions,
            }
          : {
              messageId: sessionPromptPayloadSchema.parse(frame.data.payload).messageId,
              status: 'accepted',
            };
    socket.send(
      JSON.stringify({
        type: 'response',
        requestId: frame.data.requestId,
        ok: true,
        result,
      })
    );
  });

  return { socket, wrapperInstanceId, requests, requestTimeouts, responses };
}

describe('SandboxSession durable message intent', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (
        request.method === 'POST' &&
        (pathname === '/api/openrouter/models/validate' ||
          /^\/api\/organizations\/[^/]+\/models\/validate$/.test(pathname))
      ) {
        return Response.json({ valid: true });
      }
      throw new Error('Unexpected network request in session intent test');
    });
  });

  afterEach(async () => {
    await reset();
    vi.restoreAllMocks();
  });

  it('preserves a sibling worktree BYOC binding through registration and rejects rebinding', async () => {
    const sourceSessionId = `workspace_${crypto.randomUUID()}` as const;
    const siblingSessionId = `workspace_${crypto.randomUUID()}` as const;
    const organizationId = crypto.randomUUID();
    const worktreeId = `worktree_${crypto.randomUUID()}` as const;
    const sandboxId = 'ses-a27' as const;
    const sandboxProviderBinding = {
      kind: 'vercel',
      source: { kind: 'byoc', organizationId, credentialId: crypto.randomUUID() },
    } as const;
    const sourceStub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sourceSessionId}`);
    await sourceStub.registerSession({
      ...registration(sourceSessionId, sandboxId),
      identity: { sessionId: sourceSessionId, userId: ownerId, orgId: organizationId },
      repository: { type: 'github', repo: 'acme/repo', upstreamBranch: 'feature/shared' },
      workspace: {
        sandboxId,
        sandboxProvider: 'vercel',
        sandboxProviderBinding,
        worktreeId,
        workspacePath: getWorktreeWorkspacePath(organizationId, ownerId, worktreeId),
        branchName: 'feature/shared',
      },
      finalization: { autoCommit: false, condenseOnComplete: true },
    });
    const source = await sourceStub.getMetadata();
    if (!source?.workspace) throw new Error('Expected registered worktree metadata');
    const siblingStub = env.SANDBOX_SESSION.getByName(`${ownerId}:${siblingSessionId}`);
    const input: RegisterSessionInput = {
      identity: { ...source.identity, sessionId: siblingSessionId },
      auth: { ...source.auth, kiloSessionId: 'ses_ZYXWVUTSRQPONMLKJIHGFEDCBA' },
      agent: source.agent,
      repository: source.repository,
      workspace: source.workspace,
      finalization: source.finalization,
    };

    await runInDurableObject(siblingStub, async (instance, state) => {
      pauseDispatch(instance);
      await expect(instance.registerSession(input)).resolves.toEqual({ success: true });
      await expect(instance.registerSession(input)).resolves.toEqual({ success: true });
      expect(await instance.getCredentialMetadata()).toMatchObject({
        identity: { sessionId: siblingSessionId, orgId: organizationId },
        repository: { upstreamBranch: 'feature/shared' },
        workspace: { sandboxId, sandboxProviderBinding, worktreeId },
        finalization: source.finalization,
      });
      for (const binding of [
        undefined,
        { kind: 'vercel', source: { kind: 'platform' } },
        {
          ...sandboxProviderBinding,
          source: { ...sandboxProviderBinding.source, credentialId: crypto.randomUUID() },
        },
        {
          ...sandboxProviderBinding,
          source: { ...sandboxProviderBinding.source, organizationId: crypto.randomUUID() },
        },
      ] as const) {
        await expect(
          instance.registerSession({
            ...input,
            workspace: { ...input.workspace, sandboxProviderBinding: binding },
          })
        ).resolves.toMatchObject({ success: false });
      }
      await expect(
        instance.registerSession({
          ...input,
          identity: { ...input.identity, orgId: crypto.randomUUID() },
        })
      ).resolves.toMatchObject({ success: false });
      const messageId = createMessageId();
      await expect(
        instance.admitSubmittedMessage({
          userId: ownerId,
          turn: { type: 'prompt', id: messageId, prompt: 'Continue in the shared checkout' },
        })
      ).resolves.toMatchObject({ success: true, messageId });
      expect(await state.storage.get<SessionMessageRecord[]>('session_messages')).toMatchObject([
        { messageId, intent: { finalization: source.finalization } },
      ]);
      expect(await instance.getCredentialMetadata()).toMatchObject({
        workspace: source.workspace,
      });
    });
  });

  it('preserves and replays prepared initial prompts with ownership checks', async () => {
    const sessionId = 'workspace_prepared_prompt' as const;
    const sandboxId = 'ses-a11' as const;
    const messageId = createMessageId();
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      pauseDispatch(instance);
      await expect(
        instance.registerSession({
          ...registration(sessionId, sandboxId),
          identity: { sessionId, userId: ownerId, botId: 'bot_expected' },
          message: {
            initialMessageId: messageId,
            turn: { type: 'prompt', id: messageId, prompt: 'Review the document', attachments },
          },
        })
      ).resolves.toEqual({ success: true });
      expect((await instance.getMetadata())?.initialMessage).toEqual({
        id: messageId,
        prompt: 'Review the document',
        attachments,
        turn: { type: 'prompt', prompt: 'Review the document', attachments },
      });
      await expect(
        instance.replayPreparedInitialMessage({ userId: ownerId, botId: 'bot_expected' })
      ).resolves.toBeUndefined();
      await expect(
        instance.admitPreparedInitialMessage({ userId: 'user_other', botId: 'bot_expected' })
      ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
      await expect(
        instance.admitPreparedInitialMessage({ userId: ownerId, botId: 'bot_other' })
      ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });

      const request = { userId: ownerId, botId: 'bot_expected' };
      const first = await instance.admitPreparedInitialMessage(request);
      const retry = await instance.admitPreparedInitialMessage(request);
      const replay = await instance.replayPreparedInitialMessage(request);

      expect(first).toEqual({
        success: true,
        outcome: 'queued',
        messageId,
        compatibilityDelivery: 'queued',
      });
      expect(retry).toEqual(first);
      expect(replay).toEqual(first);
      expect(await state.storage.get<SessionMessageRecord[]>('session_messages')).toEqual([
        {
          version: 2,
          messageId,
          state: 'queued',
          intent: {
            turn: { type: 'prompt', messageId, prompt: 'Review the document', attachments },
            agent: { mode: 'code', model: 'kilo/default-model', variant: 'balanced' },
            finalization: { autoCommit: true, condenseOnComplete: false },
          },
        },
      ]);
    });
  });

  it('preserves prepared commands and renders their queued slash-command content', async () => {
    const sessionId = 'workspace_prepared_command' as const;
    const messageId = createMessageId();
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      pauseDispatch(instance);
      await instance.registerSession({
        ...registration(sessionId, 'ses-a12'),
        message: {
          initialMessageId: messageId,
          turn: {
            type: 'command',
            id: messageId,
            command: 'compact',
            arguments: '--aggressive',
          },
        },
      });

      expect((await instance.getMetadata())?.initialMessage).toEqual({
        id: messageId,
        prompt: '/compact --aggressive',
        turn: { type: 'command', command: 'compact', arguments: '--aggressive' },
      });
      await expect(
        instance.admitPreparedInitialMessage({ userId: ownerId })
      ).resolves.toMatchObject({
        success: true,
        messageId,
      });
      expect(await state.storage.get<SessionMessageRecord[]>('session_messages')).toMatchObject([
        {
          version: 2,
          messageId,
          intent: {
            turn: { type: 'command', messageId, command: 'compact', arguments: '--aggressive' },
            agent: { mode: 'code', model: 'kilo/default-model', variant: 'balanced' },
            finalization: { autoCommit: true, condenseOnComplete: false },
          },
        },
      ]);
      expect(await instance['deriveQueuedMessages']()).toMatchObject([
        { messageId, content: '/compact --aggressive' },
      ]);
    });
  });

  it('durably resolves overrides and rejects conflicting or terminal message-ID reuse', async () => {
    const sessionId = 'workspace_message_overrides' as const;
    const messageId = createMessageId();
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      pauseDispatch(instance);
      await instance.registerSession(registration(sessionId, 'ses-a13'));
      const request = {
        userId: ownerId,
        turn: { type: 'prompt' as const, id: messageId, prompt: 'Inspect attachment', attachments },
        agent: { mode: 'plan', model: 'kilo/override-model', variant: 'thinking' },
        finalization: { autoCommit: false, condenseOnComplete: true },
      };

      const first = await instance.admitSubmittedMessage(request);
      await expect(instance.admitSubmittedMessage(request)).resolves.toEqual(first);
      const records = await state.storage.get<SessionMessageRecord[]>('session_messages');
      expect(records).toEqual([
        {
          version: 2,
          messageId,
          state: 'queued',
          intent: {
            turn: { type: 'prompt', messageId, prompt: 'Inspect attachment', attachments },
            agent: { mode: 'plan', model: 'kilo/override-model', variant: 'thinking' },
            finalization: { autoCommit: false, condenseOnComplete: true },
          },
        },
      ]);
      expect(records?.[0]).not.toHaveProperty('prompt');

      for (const conflicting of [
        { ...request, turn: { ...request.turn, prompt: 'Different prompt' } },
        {
          ...request,
          turn: {
            ...request.turn,
            attachments: {
              ...attachments,
              files: ['123e4567-e89b-12d3-a456-426614174002.pdf'],
            },
          },
        },
        { ...request, agent: { ...request.agent, model: 'different-model' } },
        { ...request, agent: { ...request.agent, mode: 'code' } },
        { ...request, agent: { ...request.agent, variant: 'balanced' } },
        { ...request, finalization: { ...request.finalization, autoCommit: true } },
      ]) {
        await expect(instance.admitSubmittedMessage(conflicting)).resolves.toMatchObject({
          success: false,
          code: 'BAD_REQUEST',
          error: 'Message ID conflicts with its existing intent or is already terminal',
        });
      }

      const original = records?.[0];
      if (!original) throw new Error('Expected queued message');
      await state.storage.put('session_messages', [
        { ...original, state: 'accepted', acceptedAt: 123 },
      ]);
      await expect(instance.admitSubmittedMessage(request)).resolves.toMatchObject({
        success: true,
        compatibilityDelivery: 'sent',
      });
      for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
        await state.storage.put('session_messages', [{ ...original, state: terminal }]);
        await expect(instance.admitSubmittedMessage(request)).resolves.toMatchObject({
          success: false,
          code: 'BAD_REQUEST',
          error: 'Message ID conflicts with its existing intent or is already terminal',
        });
      }
    });
  });

  it('keeps grouped initial creation idempotent without accepting changed intent or configuration', async () => {
    const sessionId = 'workspace_initial_idempotence' as const;
    const messageId = createMessageId();
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      pauseDispatch(instance);
      const input = {
        ...registration(sessionId, 'ses-a14'),
        message: {
          initialTurn: {
            type: 'prompt' as const,
            messageId,
            prompt: 'Create the session',
            attachments,
          },
        },
      };
      const first = await instance.createSessionWithInitialAdmission(input);
      await expect(instance.createSessionWithInitialAdmission(input)).resolves.toEqual(first);
      expect(await state.storage.get<SessionMessageRecord[]>('session_messages')).toHaveLength(1);

      await expect(
        instance.createSessionWithInitialAdmission({
          ...input,
          message: {
            initialTurn: { ...input.message.initialTurn, prompt: 'Changed initial turn' },
          },
        })
      ).resolves.toMatchObject({
        success: false,
        code: 'BAD_REQUEST',
        error: 'Initial turn does not match registered session intent',
      });
      await expect(
        instance.createSessionWithInitialAdmission({
          ...input,
          agent: { ...input.agent, model: 'different-model' },
        })
      ).resolves.toMatchObject({
        success: false,
        code: 'BAD_REQUEST',
        error: 'Message ID conflicts with its existing intent or is already terminal',
      });
      await expect(
        instance.createSessionWithInitialAdmission({
          ...input,
          finalization: { ...input.finalization, autoCommit: false },
        })
      ).resolves.toMatchObject({
        success: false,
        code: 'BAD_REQUEST',
        error: 'Message ID conflicts with its existing intent or is already terminal',
      });
    });
  });

  it('retains compatible replay behavior for previously persisted flat prompt records', async () => {
    const sessionId = 'workspace_legacy_flat_message' as const;
    const messageId = createMessageId();
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      pauseDispatch(instance);
      await instance.registerSession(registration(sessionId, 'ses-a15'));
      await state.storage.put('session_messages', [
        { messageId, state: 'queued', prompt: 'Legacy prompt' },
      ]);

      await expect(
        instance.admitSubmittedMessage({
          userId: ownerId,
          turn: { type: 'prompt', id: messageId, prompt: 'Legacy prompt' },
          agent: { model: 'default-model' },
        })
      ).resolves.toMatchObject({ success: true, messageId });
      await expect(
        instance.admitSubmittedMessage({
          userId: ownerId,
          turn: { type: 'prompt', id: messageId, prompt: 'Legacy prompt' },
          agent: { model: 'changed-default' },
        })
      ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
      await expect(
        instance.admitSubmittedMessage({
          userId: ownerId,
          turn: { type: 'prompt', id: messageId, prompt: 'Conflicting prompt' },
        })
      ).resolves.toMatchObject({ success: false, code: 'BAD_REQUEST' });
    });
  });

  it('keeps executions older than 90 seconds alive after fresh Kilo activity', async () => {
    const sessionId = 'workspace_recent_execution_activity' as const;
    const messageId = createMessageId();
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      pauseDispatch(instance);
      await instance.registerSession(registration(sessionId, 'ses-a17'));
      const acceptedAt = Date.now() - 120_000;
      await state.storage.put('session_messages', [
        {
          messageId,
          state: 'accepted',
          acceptedAt,
          lastActivityAt: acceptedAt,
        },
      ]);

      const beforeActivity = Date.now();
      await instance.receiveSandboxControlEvent({
        identity: {
          directory: getSessionWorkspacePath(undefined, ownerId, sessionId),
          rootKiloSessionId: kiloSessionId,
        },
        payload: {
          type: 'session.status',
          properties: { sessionID: kiloSessionId, status: { type: 'busy' } },
        },
      });
      await instance.alarm();

      const stored = (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0];
      expect(stored?.state).toBe('accepted');
      expect(stored?.lastActivityAt).toBeGreaterThanOrEqual(beforeActivity);
      expect(await state.storage.getAlarm()).toBeGreaterThan(beforeActivity);
    });
  });

  it('reconciles overdue executions against authoritative busy versus idle Kilo status', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}` as const;
    const sandboxId = 'ses-a18' as const;
    const messageId = createMessageId();
    const { socket, wrapperInstanceId, requests, responses } = await connectReadySandbox(
      sandboxId,
      sessionId
    );
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    try {
      await runInDurableObject(stub, async (instance, state) => {
        await instance.registerSession(registration(sessionId, sandboxId));
        const dispatch = instance['dispatchQueued'].bind(instance);
        pauseDispatch(instance);
        await instance.admitSubmittedMessage({
          userId: ownerId,
          turn: { type: 'prompt', id: messageId, prompt: 'Observe execution liveness' },
        });
        await dispatch(messageId, { allowCreate: true });
        const accepted = (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0];
        expect(accepted).toMatchObject({ state: 'accepted', wrapperInstanceId });
        if (!accepted || accepted.state !== 'accepted')
          throw new Error('Expected accepted message');
        const acceptedAt = Date.now() - 120_000;
        await state.storage.put('session_messages', [
          { ...accepted, acceptedAt, lastActivityAt: acceptedAt },
        ]);

        await instance.alarm();
        const active = (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0];
        expect(active?.state).toBe('accepted');
        expect(active?.lastActivityAt).toBeGreaterThan(acceptedAt);

        responses.sessionStatus = 'idle';
        await state.storage.put('session_messages', [{ ...active, lastActivityAt: acceptedAt }]);
        await instance.alarm();

        expect(await instance.getMessageResult(messageId)).toMatchObject({
          type: 'found',
          result: { status: 'failed' },
        });
        const events = instance['eventQueries'].findByFilters({
          eventTypes: ['cloud.message.sent', 'cloud.message.failed'],
        });
        expect(events.map(event => event.stream_event_type)).toEqual([
          'cloud.message.sent',
          'cloud.message.failed',
        ]);
        expect(JSON.parse(events[1]?.payload ?? '{}')).toMatchObject({
          messageId,
          status: 'failed',
          delivery: 'sent',
          accepted: true,
          reason: 'runtime_unhealthy',
        });
      });

      expect(requests.filter(request => request.operation === 'session.sync')).toHaveLength(2);
    } finally {
      socket.close();
    }
  });

  it('immediately fails and quarantines the same wrapper on an unavailable authoritative probe without redispatch or repeated terminal effects', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}` as const;
    const sandboxId = 'ses-a26' as const;
    const messageId = createMessageId();
    const jobs: CallbackJob[] = [];
    const { socket, wrapperInstanceId, requests, responses } = await connectReadySandbox(
      sandboxId,
      sessionId
    );
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);
    const control = env.SANDBOX_CONTROL.getByName(sandboxId);
    const provider = createMemoryProviderAdapter({ stopRetryable: true });
    const create = vi.spyOn(provider, 'create');
    const stop = vi.spyOn(provider, 'stop');
    vi.spyOn(provider, 'observe').mockImplementation(async ref => ({
      status: 'active',
      ...(ref ? { providerRef: ref } : {}),
    }));

    try {
      const allocation = await runInDurableObject(control, async instance => {
        Object.assign(instance, { provider, createProviderAdapter: async () => provider });
        return instance.getPhysicalRecord();
      });
      expect(allocation).toMatchObject({ state: 'running', stopTombstone: null });
      await runInDurableObject(stub, async (instance, state) => {
        Object.assign(instance['env'], {
          CALLBACK_QUEUE: {
            send: async (job: CallbackJob) => {
              jobs.push(job);
            },
          },
        });
        await instance.registerSession({
          ...registration(sessionId, sandboxId),
          callback: { target: { url: 'https://callbacks.example/liveness' } },
        });
        const dispatch = vi.fn(instance['dispatchQueued'].bind(instance));
        pauseDispatch(instance);
        await instance.admitSubmittedMessage({
          userId: ownerId,
          turn: { type: 'prompt', id: messageId, prompt: 'Observe execution liveness' },
        });
        await dispatch(messageId, { allowCreate: true });
        instance['dispatchQueued'] = dispatch;
        const accepted = (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0];
        expect(accepted).toMatchObject({ state: 'accepted', wrapperInstanceId });
        if (!accepted || accepted.state !== 'accepted')
          throw new Error('Expected accepted message');
        const acceptedAt = Date.now() - 120_000;
        for (const healthy of [
          { sessionStatus: 'busy', questions: [], permissions: [] },
          { sessionStatus: 'retry', questions: [], permissions: [] },
          { sessionStatus: 'idle', questions: [{ id: 'question_liveness' }], permissions: [] },
          { sessionStatus: 'idle', questions: [], permissions: [{ id: 'permission_liveness' }] },
        ] satisfies Pick<SandboxResponses, 'sessionStatus' | 'questions' | 'permissions'>[]) {
          Object.assign(responses, healthy);
          await state.storage.put('session_messages', [
            { ...accepted, acceptedAt, lastActivityAt: acceptedAt },
          ]);
          await instance.alarm();
          const active = (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0];
          expect(active).toMatchObject({ state: 'accepted', wrapperInstanceId });
          expect(active?.lastActivityAt).toBeGreaterThan(acceptedAt);
          expect(stop).not.toHaveBeenCalled();
          expect(jobs).toHaveLength(0);
        }
        expect(requests.filter(request => request.operation === 'session.sync')).toHaveLength(4);
        await state.storage.put('session_messages', [
          { ...accepted, acceptedAt, lastActivityAt: acceptedAt },
        ]);
        responses.syncRetryableFailure = true;

        await instance.alarm();
        const result = await instance.getMessageResult(messageId);
        expect(result).toMatchObject({ type: 'found', result: { status: 'failed' } });
        expect(
          (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0]
        ).toMatchObject({
          messageId,
          state: 'failed',
          failedReason: 'runtime_unhealthy',
          error: 'The session runtime stopped responding',
          wrapperInstanceId,
          terminalAt: expect.any(Number),
        });
        expect(await state.storage.get('pending_runtime_cleanup')).toBeUndefined();
        await vi.waitFor(async () => {
          expect(jobs).toHaveLength(1);
          expect(
            (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0]?.callback
          ).toMatchObject({ status: 'enqueued', attempts: 1 });
        });
        const settled = await state.storage.get<SessionMessageRecord[]>('session_messages');
        const events = instance['eventQueries'].findByFilters({
          eventTypes: ['cloud.message.sent', 'cloud.message.completed', 'cloud.message.failed'],
        });
        expect(events.map(event => event.stream_event_type)).toEqual([
          'cloud.message.sent',
          'cloud.message.failed',
        ]);
        expect(JSON.parse(events[1]?.payload ?? '{}')).toMatchObject({
          messageId,
          status: 'failed',
          delivery: 'sent',
          accepted: true,
          reason: 'runtime_unhealthy',
          error: 'The session runtime stopped responding',
        });
        responses.syncRetryableFailure = false;
        responses.sessionStatus = 'busy';
        responses.questions = [];
        responses.permissions = [];
        await instance.alarm();
        await instance.alarm();
        expect(await instance.getMessageResult(messageId)).toEqual(result);
        expect(await state.storage.get('session_messages')).toEqual(settled);
        expect(
          instance['eventQueries'].findByFilters({
            eventTypes: ['cloud.message.sent', 'cloud.message.completed', 'cloud.message.failed'],
          })
        ).toEqual(events);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.payload).toMatchObject({
          messageId,
          idempotencyKey: messageId,
          status: 'failed',
          errorMessage: 'The session runtime stopped responding',
        });
      });

      await vi.waitFor(async () => {
        expect(stop).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledWith(allocation.providerRef, allocation.createIntent);
        await runInDurableObject(control, async (instance, state) => {
          expect(await instance.getPhysicalRecord()).toMatchObject({
            state: 'stopping',
            providerRef: allocation.providerRef,
            createIntent: allocation.createIntent,
            stopTombstone: { reason: 'runtime_unhealthy', wrapperInstanceId, attempts: 1 },
          });
          const deadlines = await state.storage.get<{ stopAttempt?: number }>('deadlines');
          expect(deadlines?.stopAttempt).toBeGreaterThan(Date.now());
          expect(await state.storage.getAlarm()).not.toBeNull();
        });
      });
      expect(create).not.toHaveBeenCalled();
      expect(requests.filter(request => request.operation === 'session.attach')).toHaveLength(1);
      expect(requests.filter(request => request.operation === 'session.prompt')).toHaveLength(1);
      expect(requests.filter(request => request.operation === 'session.sync')).toHaveLength(5);
    } finally {
      socket.close();
    }
  });

  it('records preparation after attachment and initiation only after accepted prompt dispatch', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}` as const;
    const sandboxId = 'ses-a19' as const;
    const messageId = createMessageId();
    const { socket, responses, requestTimeouts } = await connectReadySandbox(sandboxId, sessionId);
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    try {
      await runInDurableObject(stub, async (instance, state) => {
        await instance.registerSession(registration(sessionId, sandboxId));
        expect((await instance.getMetadata())?.lifecycle).not.toHaveProperty('preparedAt');
        expect((await instance.getMetadata())?.lifecycle).not.toHaveProperty('initiatedAt');

        const dispatch = instance['dispatchQueued'].bind(instance);
        pauseDispatch(instance);
        await instance.admitSubmittedMessage({
          userId: ownerId,
          turn: { type: 'prompt', id: messageId, prompt: 'Start after preparation' },
        });
        responses.promptAccepted = false;
        await dispatch(messageId, { allowCreate: true });

        const prepared = (await instance.getMetadata())?.lifecycle;
        expect(prepared?.preparedAt).toEqual(expect.any(Number));
        expect(prepared?.initiatedAt).toBeUndefined();
        expect(
          (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0]?.state
        ).toBe('queued');

        responses.promptAccepted = true;
        await dispatch(messageId, { allowCreate: true });
        const initiated = (await instance.getMetadata())?.lifecycle;
        expect(initiated?.preparedAt).toBe(prepared?.preparedAt);
        expect(initiated?.initiatedAt).toEqual(expect.any(Number));
        if (initiated?.preparedAt === undefined || initiated.initiatedAt === undefined) {
          throw new Error('Expected lifecycle timestamps');
        }
        expect(initiated.initiatedAt).toBeGreaterThanOrEqual(initiated.preparedAt);
        expect(
          instance['eventQueries'].findByFilters({ eventTypes: ['cloud.message.sent'] })
        ).toHaveLength(1);
      });

      expect(requestTimeouts).toEqual([{ messageId }, { messageId }]);
    } finally {
      socket.close();
    }
  });

  it('persists exactly one sent/completed event and one assistant-aware completion callback', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}` as const;
    const sandboxId = 'ses-a20' as const;
    const messageId = createMessageId();
    const assistantMessageId = 'assistant_completion';
    const jobs: CallbackJob[] = [];
    const { socket, wrapperInstanceId } = await connectReadySandbox(sandboxId, sessionId);
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    try {
      await runInDurableObject(stub, async (instance, state) => {
        Object.assign(instance['env'], {
          CALLBACK_QUEUE: {
            send: async (job: CallbackJob) => {
              jobs.push(job);
            },
          },
        });
        await instance.registerSession({
          ...registration(sessionId, sandboxId),
          callback: { target: { url: 'https://callbacks.example/completed' } },
        });
        const dispatch = instance['dispatchQueued'].bind(instance);
        pauseDispatch(instance);
        const request = {
          userId: ownerId,
          turn: { type: 'prompt' as const, id: messageId, prompt: 'Produce a result' },
        };
        await instance.admitSubmittedMessage(request);
        await dispatch(messageId, { allowCreate: true });
        await instance.admitSubmittedMessage(request);

        const identity = {
          directory: getSessionWorkspacePath(undefined, ownerId, sessionId),
          rootKiloSessionId: kiloSessionId,
        };
        await instance.receiveSandboxControlEvent({
          identity,
          payload: {
            type: 'message.updated',
            properties: {
              info: {
                id: assistantMessageId,
                role: 'assistant',
                sessionID: kiloSessionId,
                parentID: messageId,
                time: { completed: Date.now() },
              },
            },
          },
        });
        for (const [index, text] of ['Result ', 'finished'].entries()) {
          await instance.receiveSandboxControlEvent({
            identity,
            payload: {
              type: 'message.part.updated',
              properties: {
                part: {
                  id: `part_${index}`,
                  messageID: assistantMessageId,
                  sessionID: kiloSessionId,
                  type: 'text',
                  text,
                },
              },
            },
          });
        }
        await instance.receiveSandboxControlEvent({
          identity,
          wrapperInstanceId,
          payload: { type: 'session.turn.close', properties: { sessionID: kiloSessionId } },
        });
        expect(await instance.getMessageResult(messageId)).toMatchObject({
          type: 'found',
          result: { status: 'running' },
        });
        const completed = {
          identity,
          wrapperInstanceId,
          payload: {
            type: 'session.message.outcome',
            properties: { messageId, status: 'completed' },
          },
        };
        await instance.receiveSandboxControlEvent(completed);
        await instance.receiveSandboxControlEvent(completed);
        await instance.alarm();
        await instance.alarm();

        const events = instance['eventQueries'].findByFilters({
          eventTypes: ['cloud.message.sent', 'cloud.message.completed'],
        });
        expect(events.map(event => event.stream_event_type)).toEqual([
          'cloud.message.sent',
          'cloud.message.completed',
        ]);
        expect(JSON.parse(events[1]?.payload ?? '{}')).toEqual({
          messageId,
          status: 'completed',
          delivery: 'sent',
          accepted: true,
        });
        expect(
          (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0]?.callback
        ).toMatchObject({
          status: 'enqueued',
          attempts: 1,
        });
      });

      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        target: { url: 'https://callbacks.example/completed' },
        payload: {
          sessionId,
          cloudAgentSessionId: sessionId,
          executionId: messageId,
          messageId,
          idempotencyKey: messageId,
          status: 'completed',
          kiloSessionId,
          lastAssistantMessageText: 'Result finished',
        },
      });
    } finally {
      socket.close();
    }
  });

  it('durably retries transient callback queue failures without duplicating terminal events', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}` as const;
    const messageId = createMessageId();
    const wrapperInstanceId = crypto.randomUUID();
    const jobs: CallbackJob[] = [];
    let attempts = 0;
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      Object.assign(instance['env'], {
        CALLBACK_QUEUE: {
          send: async (job: CallbackJob) => {
            attempts += 1;
            if (attempts === 1) throw new Error('callback queue temporarily unavailable');
            jobs.push(job);
          },
        },
      });
      pauseDispatch(instance);
      await instance.registerSession({
        ...registration(sessionId, 'ses-a21'),
        callback: { target: { url: 'https://callbacks.example/retry' } },
      });
      await instance.admitSubmittedMessage({
        userId: ownerId,
        turn: { type: 'prompt', id: messageId, prompt: 'Retry callback delivery' },
      });
      const queued = (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0];
      if (!queued) throw new Error('Expected queued message');
      const acceptedAt = Date.now();
      await state.storage.put('session_messages', [
        {
          ...queued,
          state: 'accepted',
          acceptedAt,
          lastActivityAt: acceptedAt,
          wrapperInstanceId,
        },
      ]);

      await instance.receiveSandboxControlEvent({
        identity: {
          directory: getSessionWorkspacePath(undefined, ownerId, sessionId),
          rootKiloSessionId: kiloSessionId,
        },
        wrapperInstanceId,
        payload: {
          type: 'session.message.outcome',
          properties: { messageId, status: 'completed' },
        },
      });
      await vi.waitFor(async () => {
        expect(attempts).toBe(1);
        expect(
          (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0]?.callback
        ).toMatchObject({ status: 'pending', attempts: 1 });
      });
      const pending = (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0];
      expect(pending?.state).toBe('completed');
      expect(pending?.callback).toMatchObject({ status: 'pending', attempts: 1 });
      expect(pending?.callback?.retryAt).toBeGreaterThan(Date.now());
      expect(await state.storage.getAlarm()).not.toBeNull();
      expect(jobs).toHaveLength(0);
      if (!pending?.callback) throw new Error('Expected pending callback');

      await state.storage.put('session_messages', [
        { ...pending, callback: { ...pending.callback, retryAt: Date.now() - 1 } },
      ]);
      await instance.alarm();
      await vi.waitFor(async () => {
        expect(attempts).toBe(2);
        expect(
          (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0]?.callback
        ).toMatchObject({ status: 'enqueued', attempts: 2 });
      });
      await instance.alarm();

      expect(attempts).toBe(2);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.payload.idempotencyKey).toBe(messageId);
      expect(
        (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0]?.callback
      ).toMatchObject({
        status: 'enqueued',
        attempts: 2,
      });
      expect(
        instance['eventQueries'].findByFilters({ eventTypes: ['cloud.message.completed'] })
      ).toHaveLength(1);
    });
  });

  it('sanitizes Kilo failures and emits one canonical failure event and callback', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}` as const;
    const messageId = createMessageId();
    const wrapperInstanceId = crypto.randomUUID();
    const jobs: CallbackJob[] = [];
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      Object.assign(instance['env'], {
        CALLBACK_QUEUE: {
          send: async (job: CallbackJob) => {
            jobs.push(job);
          },
        },
      });
      pauseDispatch(instance);
      await instance.registerSession({
        ...registration(sessionId, 'ses-a22'),
        callback: { target: { url: 'https://callbacks.example/failed' } },
      });
      await instance.admitSubmittedMessage({
        userId: ownerId,
        turn: { type: 'prompt', id: messageId, prompt: 'Fail safely' },
      });
      const queued = (await state.storage.get<SessionMessageRecord[]>('session_messages'))?.[0];
      if (!queued) throw new Error('Expected queued message');
      const acceptedAt = Date.now();
      await state.storage.put('session_messages', [
        { ...queued, state: 'accepted', acceptedAt, wrapperInstanceId },
      ]);

      const failure = {
        identity: {
          directory: getSessionWorkspacePath(undefined, ownerId, sessionId),
          rootKiloSessionId: kiloSessionId,
        },
        payload: {
          type: 'session.error',
          properties: {
            sessionID: kiloSessionId,
            error: { data: { message: 'Payment Required api-key=must-not-escape' } },
          },
        },
      };
      await instance.receiveSandboxControlEvent(failure);
      await instance.receiveSandboxControlEvent(failure);
      expect(await instance.getMessageResult(messageId)).toMatchObject({
        type: 'found',
        result: { status: 'running' },
      });
      const outcome = {
        identity: failure.identity,
        wrapperInstanceId,
        payload: {
          type: 'session.message.outcome',
          properties: { messageId, status: 'failed', reason: 'Payment Required' },
        },
      };
      await instance.receiveSandboxControlEvent(outcome);
      await instance.receiveSandboxControlEvent(outcome);
      await instance.alarm();

      const failures = instance['eventQueries'].findByFilters({
        eventTypes: ['cloud.message.failed'],
      });
      expect(failures).toHaveLength(1);
      expect(JSON.parse(failures[0]?.payload ?? '{}')).toEqual({
        messageId,
        status: 'failed',
        delivery: 'sent',
        accepted: true,
        reason: 'Payment Required',
        error: 'Assistant request failed: insufficient credits',
        timestamp: acceptedAt,
      });
      const kiloEvents = instance['eventQueries'].findByFilters({ eventTypes: ['kilocode'] });
      expect(JSON.stringify(kiloEvents)).not.toContain('must-not-escape');
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      messageId,
      executionId: messageId,
      idempotencyKey: messageId,
      status: 'failed',
      errorMessage: 'Assistant request failed: insufficient credits',
      clientError: {
        message: 'Assistant request failed: insufficient credits',
      },
    });
  });

  it('settles assistant failures only when their fenced outcomes match the accepted turn', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}` as const;
    const messageId = createMessageId();
    const previousMessageId = createMessageId();
    const wrapperInstanceId = crypto.randomUUID();
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async (instance, state) => {
      pauseDispatch(instance);
      await instance.registerSession(registration(sessionId, 'ses-a25'));
      await state.storage.put('session_messages', [
        { messageId, state: 'accepted', acceptedAt: Date.now(), wrapperInstanceId },
      ]);

      const identity = {
        directory: getSessionWorkspacePath(undefined, ownerId, sessionId),
        rootKiloSessionId: kiloSessionId,
      };
      await instance.receiveSandboxControlEvent({
        identity,
        payload: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'assistant_previous',
              role: 'assistant',
              sessionID: kiloSessionId,
              parentID: previousMessageId,
              error: { data: { message: 'stale assistant failure' } },
            },
          },
        },
      });
      await expect(
        instance.receiveSandboxControlEvent({
          identity,
          wrapperInstanceId,
          payload: {
            type: 'session.message.outcome',
            properties: {
              messageId: previousMessageId,
              status: 'failed',
              reason: 'stale assistant failure',
            },
          },
        })
      ).resolves.toEqual({ applied: false });
      expect(await instance.getMessageResult(messageId)).toMatchObject({
        type: 'found',
        result: { status: 'running' },
      });

      await instance.receiveSandboxControlEvent({
        identity,
        payload: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'assistant_current',
              role: 'assistant',
              sessionID: kiloSessionId,
              parentID: messageId,
              error: { data: { message: 'Too Many Requests api-key=hidden' } },
            },
          },
        },
      });
      expect(await instance.getMessageResult(messageId)).toMatchObject({
        type: 'found',
        result: { status: 'running' },
      });
      const outcome = {
        identity,
        wrapperInstanceId,
        payload: {
          type: 'session.message.outcome',
          properties: { messageId, status: 'failed', reason: 'Too Many Requests' },
        },
      };
      await expect(
        instance.receiveSandboxControlEvent({ ...outcome, wrapperInstanceId: crypto.randomUUID() })
      ).resolves.toEqual({ applied: false });
      await expect(instance.receiveSandboxControlEvent(outcome)).resolves.toEqual({
        applied: true,
      });

      expect(await instance.getMessageResult(messageId)).toMatchObject({
        type: 'found',
        result: { status: 'failed' },
      });
      const failures = instance['eventQueries'].findByFilters({
        eventTypes: ['cloud.message.failed'],
      });
      expect(failures).toHaveLength(1);
      expect(JSON.parse(failures[0]?.payload ?? '{}')).toMatchObject({
        messageId,
        reason: 'Too Many Requests',
        error: 'Assistant request was rate limited',
      });
      expect(
        JSON.stringify(instance['eventQueries'].findByFilters({ eventTypes: ['kilocode'] }))
      ).not.toContain('api-key=hidden');
    });
  });

  it('notifies queued delivery failures exactly once without claiming wrapper acceptance', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}` as const;
    const messageId = createMessageId();
    const jobs: CallbackJob[] = [];
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    await runInDurableObject(stub, async instance => {
      Object.assign(instance['env'], {
        CALLBACK_QUEUE: {
          send: async (job: CallbackJob) => {
            jobs.push(job);
          },
        },
      });
      pauseDispatch(instance);
      await instance.registerSession({
        ...registration(sessionId, 'ses-a24'),
        callback: { target: { url: 'https://callbacks.example/queued-failure' } },
      });
      await instance.admitSubmittedMessage({
        userId: ownerId,
        turn: { type: 'prompt', id: messageId, prompt: 'Fail before delivery' },
      });

      await instance.failWaitingMessages('attach_exhausted');
      await instance.failWaitingMessages('attach_exhausted');
      await instance.alarm();

      const failures = instance['eventQueries'].findByFilters({
        eventTypes: ['cloud.message.sent', 'cloud.message.failed'],
      });
      expect(failures).toHaveLength(1);
      expect(JSON.parse(failures[0]?.payload ?? '{}')).toEqual({
        messageId,
        status: 'failed',
        delivery: 'queued',
        accepted: false,
        reason: 'attach_exhausted',
        error: 'Environment preparation failed',
        timestamp: failures[0]?.timestamp,
      });
    });

    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      messageId,
      status: 'failed',
      idempotencyKey: messageId,
      errorMessage: 'Environment preparation failed',
    });
  });

  it('covers all five bounded attachment downloads with an explicit prompt RPC timeout', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}` as const;
    const sandboxId = 'ses-a23' as const;
    const messageId = createMessageId();
    const files = Array.from(
      { length: 5 },
      (_value, index) => `123e4567-e89b-12d3-a456-42661417400${index + 1}.pdf`
    );
    const { socket, requestTimeouts } = await connectReadySandbox(sandboxId, sessionId);
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    try {
      await runInDurableObject(stub, async instance => {
        Object.assign(instance['env'], {
          R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID: 'test-readonly-access-key',
          R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: 'test-readonly-secret',
          R2_ENDPOINT: 'https://attachments.example',
          R2_ATTACHMENTS_BUCKET: 'test-attachments',
        });
        await instance.registerSession(registration(sessionId, sandboxId));
        const dispatch = instance['dispatchQueued'].bind(instance);
        pauseDispatch(instance);
        await instance.admitSubmittedMessage({
          userId: ownerId,
          turn: {
            type: 'prompt',
            id: messageId,
            prompt: 'Inspect every attachment',
            attachments: { path: attachments.path, files },
          },
        });
        await dispatch(messageId, { allowCreate: true });
      });

      expect(requestTimeouts).toEqual([
        {
          messageId,
          timeoutMs:
            5 * SANDBOX_CONTROL_ATTACHMENT_DOWNLOAD_TIMEOUT_MS + SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        },
      ]);
    } finally {
      socket.close();
    }
  });

  it('dispatches signed prompt attachments, commands, and immutable per-message policy over control RPC', async () => {
    const sessionId = `workspace_${crypto.randomUUID()}` as const;
    const sandboxId = 'ses-a16' as const;
    const promptMessageId = createMessageId();
    const commandMessageId = createMessageId();
    const { socket, wrapperInstanceId, requests, requestTimeouts } = await connectReadySandbox(
      sandboxId,
      sessionId
    );
    const stub = env.SANDBOX_SESSION.getByName(`${ownerId}:${sessionId}`);

    try {
      await runInDurableObject(stub, async (instance, state) => {
        Object.assign(instance['env'], {
          R2_ATTACHMENTS_READONLY_ACCESS_KEY_ID: 'test-readonly-access-key',
          R2_ATTACHMENTS_READONLY_SECRET_ACCESS_KEY: 'test-readonly-secret',
          R2_ENDPOINT: 'https://attachments.example',
          R2_ATTACHMENTS_BUCKET: 'test-attachments',
        });
        await instance.registerSession(registration(sessionId, sandboxId));
        const dispatch = instance['dispatchQueued'].bind(instance);
        pauseDispatch(instance);

        await instance.admitSubmittedMessage({
          userId: ownerId,
          turn: {
            type: 'prompt',
            id: promptMessageId,
            prompt: 'Inspect the document',
            attachments,
          },
          agent: { mode: 'plan', model: 'kilo/prompt-model', variant: 'thinking' },
          finalization: { autoCommit: false, condenseOnComplete: true },
        });
        await dispatch(promptMessageId, { allowCreate: true });
        expect(await instance.getMessageResult(promptMessageId)).toMatchObject({
          type: 'found',
          result: { status: 'running' },
        });
        const promptRecord = (
          await state.storage.get<SessionMessageRecord[]>('session_messages')
        )?.find(message => message.messageId === promptMessageId);
        expect(promptRecord?.intent).toEqual({
          turn: {
            type: 'prompt',
            messageId: promptMessageId,
            prompt: 'Inspect the document',
            attachments,
          },
          agent: { mode: 'plan', model: 'kilo/prompt-model', variant: 'thinking' },
          finalization: { autoCommit: false, condenseOnComplete: true },
        } satisfies SessionMessageIntent);

        await instance.receiveSandboxControlEvent({
          identity: {
            directory: getSessionWorkspacePath(undefined, ownerId, sessionId),
            rootKiloSessionId: kiloSessionId,
          },
          wrapperInstanceId,
          payload: {
            type: 'session.message.outcome',
            properties: { messageId: promptMessageId, status: 'completed' },
          },
        });
        await instance.admitSubmittedMessage({
          userId: ownerId,
          turn: {
            type: 'command',
            id: commandMessageId,
            command: 'compact',
            arguments: '--aggressive',
          },
          agent: { mode: 'debug', model: 'command-model', variant: 'focused' },
          finalization: { autoCommit: true, condenseOnComplete: true },
        });
        await dispatch(commandMessageId, { allowCreate: true });
      });

      const promptRequests = requests.filter(request => request.operation === 'session.prompt');
      expect(promptRequests).toHaveLength(2);
      const prompt = sessionPromptPayloadSchema.parse(promptRequests[0]?.payload);
      expect(prompt).toMatchObject({
        messageId: promptMessageId,
        turn: {
          type: 'prompt',
          prompt: 'Inspect the document',
        },
        attachments: [
          {
            filename: attachments.files[0],
            mime: 'application/pdf',
            signedUrl: expect.stringContaining('X-Amz-Signature='),
            localPath: expect.stringContaining(`/tmp/attachments/${sessionId}/${ownerId}/`),
          },
        ],
        agent: { mode: 'plan', model: 'prompt-model', variant: 'thinking' },
        finalization: { autoCommit: false, condenseOnComplete: true },
      });
      expect(JSON.stringify(prompt)).not.toContain('test-readonly-secret');

      expect(sessionPromptPayloadSchema.parse(promptRequests[1]?.payload)).toEqual({
        messageId: commandMessageId,
        turn: { type: 'command', command: 'compact', arguments: '--aggressive' },
        agent: { mode: 'debug', model: 'command-model', variant: 'focused' },
        finalization: { autoCommit: true, condenseOnComplete: true },
      });
      expect(requestTimeouts).toEqual([
        {
          messageId: promptMessageId,
          timeoutMs:
            SANDBOX_CONTROL_ATTACHMENT_DOWNLOAD_TIMEOUT_MS + SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
        },
        { messageId: commandMessageId },
      ]);
    } finally {
      socket.close();
    }
  });
});
