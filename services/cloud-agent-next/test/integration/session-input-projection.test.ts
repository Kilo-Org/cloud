import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  cloudAgentEventSchema,
  type CloudAgentEvent,
} from '../../../../packages/cloud-agent-sdk/src/schemas';
import { normalize, isChatEvent } from '../../../../packages/cloud-agent-sdk/src/normalizer';
import { createServiceState } from '../../../../packages/cloud-agent-sdk/src/service-state';
import type { SandboxSession } from '../../src/sandbox-session/SandboxSession';
import type { ResponseFrame, SessionSyncResult } from '../../src/shared/sandbox-control-protocol';
import { events } from '../../src/db/sqlite-schema';

const root = 'ses_00000000000000000000000001';
const question = {
  id: 'question_repaired',
  sessionID: root,
  questions: [
    {
      question: 'Continue?',
      header: 'Confirm',
      options: [{ label: 'Yes', description: 'Continue' }],
    },
  ],
};
const permission = {
  id: 'permission_repaired',
  sessionID: root,
  permission: 'bash',
  patterns: ['ls'],
  metadata: {},
  always: [],
};
const empty: SessionSyncResult = { status: { type: 'busy' }, questions: [], permissions: [] };
const asks: SessionSyncResult = { ...empty, questions: [question], permissions: [permission] };
const response = (result: SessionSyncResult): ResponseFrame => ({
  type: 'response',
  requestId: 'projection',
  ok: true,
  result,
});

async function seed(instance: SandboxSession, state: DurableObjectState, initial = empty) {
  await instance.registerSession({
    identity: { sessionId: instance['requireSessionId'](), userId: 'user_projection' },
    auth: { kiloSessionId: root, kilocodeToken: 'fixture-token' },
    agent: { mode: 'code', model: 'test-model' },
    workspace: { sandboxId: 'usr-abcdef123419', workspacePath: '/workspace/shared' },
  });
  const wrapperInstanceId = crypto.randomUUID();
  const message = {
    messageId: 'msg_projection',
    state: 'accepted',
    acceptedAt: Date.now(),
    wrapperInstanceId,
  };
  state.storage.kv.put('session_messages', [message]);
  state.storage.kv.put('session_pending_interactions', {
    revision: 1,
    questions: initial.questions,
    permissions: initial.permissions,
  });
  const pending = Promise.withResolvers<ResponseFrame>();
  const request = vi.fn(() => pending.promise);
  const originalEnv = instance['env'];
  Object.assign(instance, {
    env: {
      ...originalEnv,
      SANDBOX_CONTROL: {
        getByName: () => ({
          getStatus: async () => ({ physical: 'running', connection: 'ready', wrapperInstanceId }),
          request,
        }),
      },
    },
  });
  const refresh = () =>
    instance['interactionRefresh'].refresh(
      instance['captureInteractionScope'](),
      'pending_interactions'
    );
  return {
    pending,
    request,
    refresh,
    message,
    storedEvents: () => drizzle(state.storage).select().from(events).all(),
    cleanup: async () => {
      pending.resolve(response(empty));
      Object.assign(instance, { env: originalEnv });
      await state.storage.deleteAlarm();
    },
  };
}

async function observe(result: Response) {
  expect(result.status).toBe(101);
  const socket = result.webSocket;
  if (!socket) throw new Error('Missing client socket');
  const view = createServiceState({ rootSessionId: root });
  const frames: CloudAgentEvent[] = [];
  socket.addEventListener('message', event => {
    const frame = cloudAgentEventSchema.parse(JSON.parse(String(event.data)));
    frames.push(frame);
    const normalized = normalize(frame);
    if (normalized && !isChatEvent(normalized)) view.process(normalized);
  });
  socket.accept();
  await vi.waitFor(() =>
    expect(frames.some(frame => frame.streamEventType === 'connected')).toBe(true)
  );
  return { socket, view, frames };
}

const connect = (instance: SandboxSession, query = '') =>
  instance.fetch(
    new Request(`http://worker.test/stream${query}`, { headers: { Upgrade: 'websocket' } })
  );
const inputFrames = (frames: CloudAgentEvent[]) =>
  frames.filter(frame => {
    const type = normalize(frame)?.type;
    return type?.startsWith('question.') || type?.startsWith('permission.');
  });
const drainSocketMessages = () => new Promise<void>(resolve => setTimeout(resolve, 20));

describe('Session pending-input projection', () => {
  it('updates stable request IDs, skips unchanged snapshots, and removes absent inputs with membership-only hints', async () => {
    const stub = env.SANDBOX_SESSION.getByName(`user_projection:workspace_${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const f = await seed(instance, state, asks);
      const client = await observe(await connect(instance));
      const updatedQuestion = {
        ...question,
        questions: [{ ...question.questions[0], question: 'Continue deployment?' }],
      };
      const updatedPermission = {
        ...permission,
        patterns: ['pnpm test'],
        metadata: { command: 'pnpm test' },
      };
      const updated = { ...empty, questions: [updatedQuestion], permissions: [updatedPermission] };
      try {
        await vi.waitFor(() => expect(client.view.getPermission()?.requestId).toBe(permission.id));
        expect(client.view.getQuestion()?.questions).toEqual(question.questions);
        f.pending.resolve(response(updated));
        await f.refresh();
        await vi.waitFor(() => {
          expect(client.view.getQuestion()?.questions).toEqual(updatedQuestion.questions);
          expect(client.view.getPermission()?.patterns).toEqual(updatedPermission.patterns);
        });
        expect(inputFrames(client.frames).map(frame => normalize(frame)?.type)).toEqual([
          'question.asked',
          'permission.asked',
          'question.asked',
          'permission.asked',
        ]);
        const beforeUnchanged = inputFrames(client.frames);
        f.request.mockResolvedValue(
          response({
            ...updated,
            questions: [{ questions: updatedQuestion.questions, sessionID: root, id: question.id }],
          })
        );
        await f.refresh();
        await drainSocketMessages();
        expect(inputFrames(client.frames)).toEqual(beforeUnchanged);
        f.request.mockResolvedValue(response(empty));
        await f.refresh();
        await vi.waitFor(() => {
          expect(client.view.getQuestion()).toBeNull();
          expect(client.view.getPermission()).toBeNull();
        });
        expect(
          inputFrames(client.frames)
            .slice(-2)
            .map(frame => ({ eventId: frame.eventId, data: frame.data }))
        ).toEqual([
          {
            eventId: 0,
            data: {
              type: 'question.replied',
              event: 'question.replied',
              properties: { requestID: question.id },
            },
          },
          {
            eventId: 0,
            data: {
              type: 'permission.replied',
              event: 'permission.replied',
              properties: { requestID: permission.id },
            },
          },
        ]);
        expect(f.storedEvents()).toHaveLength(3);
        expect(
          f.storedEvents().every(event => JSON.parse(event.payload).type === 'session.status')
        ).toBe(true);
        expect(state.storage.kv.get('session_pending_interactions')).toEqual({
          revision: 4,
          questions: [],
          permissions: [],
        });
        expect(state.storage.kv.get('session_messages')).toEqual([f.message]);
        expect(client.frames.filter(frame => frame.streamEventType === 'connected')).toHaveLength(
          1
        );
      } finally {
        client.socket.close();
        await f.cleanup();
      }
    });
  });

  it.each([
    { failure: 'unknown', initial: empty, next: asks },
    { failure: 'unknown', initial: asks, next: empty },
    { failure: 'failed', initial: empty, next: asks },
    { failure: 'failed', initial: asks, next: empty },
    { failure: 'stale', initial: empty, next: asks },
    { failure: 'stale', initial: asks, next: empty },
  ])(
    'suppresses $failure refresh projection with cached questions=$initial.questions.length',
    async ({ failure, initial, next }) => {
      const stub = env.SANDBOX_SESSION.getByName(
        `user_projection:workspace_${crypto.randomUUID()}`
      );
      await runInDurableObject(stub, async (instance, state) => {
        const f = await seed(instance, state, initial);
        const client = await observe(await connect(instance));
        try {
          await drainSocketMessages();
          const before = [...client.frames];
          const shared = f.refresh();
          if (failure === 'stale') {
            state.storage.kv.put('session_pending_interactions', {
              revision: 2,
              questions: initial.questions,
              permissions: initial.permissions,
            });
            f.pending.resolve(response(next));
            expect(await shared).toBeUndefined();
          } else if (failure === 'failed') {
            f.pending.reject(new Error('Native sync unavailable'));
            await expect(shared).rejects.toThrow('Native sync unavailable');
          } else {
            f.pending.resolve({
              type: 'response',
              requestId: 'unknown',
              ok: false,
              error: { code: 'not_ready', message: 'Incomplete ancestry', retryable: false },
            });
            await expect(shared).rejects.toThrow('Session sync failed');
          }
          await drainSocketMessages();
          expect(client.frames).toEqual(before);
          expect(client.view.getQuestion()?.requestId ?? null).toBe(
            initial.questions.length ? question.id : null
          );
          expect(client.view.getPermission()?.requestId ?? null).toBe(
            initial.permissions.length ? permission.id : null
          );
          expect(f.storedEvents()).toEqual([]);
          expect(state.storage.kv.get('session_messages')).toEqual([f.message]);
        } finally {
          client.socket.close();
          await f.cleanup();
        }
      });
    }
  );

  it.each([
    empty,
    {
      ...empty,
      questions: [
        { ...question, questions: [{ ...question.questions[0], question: 'Latest content' }] },
      ],
      permissions: [permission],
    },
  ])(
    'does not send stale cached asks after a repair completes during connection setup: %j',
    async next => {
      const stub = env.SANDBOX_SESSION.getByName(
        `user_projection:workspace_${crypto.randomUUID()}`
      );
      await runInDurableObject(stub, async (instance, state) => {
        const f = await seed(instance, state, asks);
        const setupStarted = Promise.withResolvers<void>();
        const setup = Promise.withResolvers<{ type: 'ready' }>();
        const original = instance['deriveCloudStatus'];
        Object.assign(instance, {
          deriveCloudStatus: () => {
            setupStarted.resolve();
            return setup.promise;
          },
        });
        const refresh = f.refresh();
        const connecting = connect(instance);
        let client: Awaited<ReturnType<typeof observe>> | undefined;
        try {
          await setupStarted.promise;
          f.pending.resolve(response(next));
          await refresh;
          setup.resolve({ type: 'ready' });
          client = await observe(await connecting);
          await f.refresh();
          await drainSocketMessages();
          expect(client.view.getQuestion()).toEqual(
            next.questions.length
              ? {
                  requestId: question.id,
                  questions: [{ ...question.questions[0], question: 'Latest content' }],
                }
              : null
          );
          expect(client.view.getPermission()?.requestId ?? null).toBe(
            next.permissions.length ? permission.id : null
          );
          const connectedIndex = client.frames.findIndex(
            frame => frame.streamEventType === 'connected'
          );
          expect(
            inputFrames(client.frames.slice(connectedIndex + 1)).map(frame => frame.data)
          ).toEqual([
            ...next.questions.map(properties => ({
              type: 'question.asked',
              event: 'question.asked',
              properties,
            })),
            ...next.permissions.map(properties => ({
              type: 'permission.asked',
              event: 'permission.asked',
              properties,
            })),
          ]);
        } finally {
          setup.resolve({ type: 'ready' });
          Object.assign(instance, { deriveCloudStatus: original });
          client?.socket.close();
          await f.cleanup();
        }
      });
    }
  );

  it('repairs inputs on an already-connected SDK consumer without reconnecting', async () => {
    const stub = env.SANDBOX_SESSION.getByName(`user_projection:workspace_${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance, state) => {
      const f = await seed(instance, state);
      const client = await observe(await connect(instance));
      const filtered = await observe(await connect(instance, '?eventTypes=output'));
      try {
        expect(client.view.getQuestion()).toBeNull();
        expect(client.view.getPermission()).toBeNull();
        f.pending.resolve(response(asks));
        await f.refresh();
        await vi.waitFor(() => {
          expect(client.view.getQuestion()).toEqual({
            requestId: question.id,
            questions: question.questions,
          });
          expect(client.view.getPermission()).toMatchObject({
            requestId: permission.id,
            permission: permission.permission,
          });
        });
        expect(f.request).toHaveBeenCalledTimes(1);
        expect(inputFrames(client.frames).map(frame => frame.data)).toEqual([
          { type: 'question.asked', event: 'question.asked', properties: question },
          { type: 'permission.asked', event: 'permission.asked', properties: permission },
        ]);
        expect(inputFrames(client.frames).every(frame => frame.eventId === 0)).toBe(true);
        expect(inputFrames(filtered.frames)).toEqual([]);
        expect(client.frames.filter(frame => frame.streamEventType === 'connected')).toHaveLength(
          1
        );
        expect(f.storedEvents()).toHaveLength(1);
        expect(JSON.parse(f.storedEvents()[0].payload).type).toBe('session.status');
        expect(state.storage.kv.get('session_pending_interactions')).toEqual({
          revision: 2,
          questions: [question],
          permissions: [permission],
        });
        expect(state.storage.kv.get('session_messages')).toEqual([f.message]);
      } finally {
        filtered.socket.close();
        client.socket.close();
        await f.cleanup();
      }
    });
  });
});
