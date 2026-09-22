import { env, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { describe, expect, it, vi } from 'vitest';
import { DEADLINE_MS } from '../../src/sandbox-control/deadlines';
import { events } from '../../src/db/sqlite-schema';
import type { SandboxSession } from '../../src/sandbox-session/SandboxSession';
import type {
  SessionMessageRecord,
  SessionOperationProof,
} from '../../src/sandbox-session/session-message-queue';
import type { SessionOperationAuthorization } from '../../src/shared/sandbox-control-protocol';

const rootKiloSessionId = 'ses_00000000000000000000000009';
const directory = '/workspace/shared';
const messageId = 'msg_no_output';

/**
 * Producer 1 of 2: the accepted-message inactivity timeout
 * (`SandboxSession.failOverdueAcceptedMessage`). This starves an accepted turn
 * of activity and drives the real DO alarm twice through Miniflare: the first
 * detection re-dispatches the same durable turn, the second terminalizes with
 * the attempt count recorded. Producer 2 (the wrapper no-output watchdog) is
 * owned by the sibling slice.
 */
describe('sandbox session no-output recovery', () => {
  it('re-dispatches an accepted no-output turn once, then terminalizes with the attempt count', async () => {
    const stub = env.SANDBOX_SESSION.getByName(`user_no_output:workspace_${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance: SandboxSession, state) => {
      const sessionId = instance['requireSessionId']();
      await instance.registerSession({
        identity: { sessionId, userId: 'user_no_output' },
        auth: { kiloSessionId: rootKiloSessionId, kilocodeToken: 'fixture-token' },
        agent: { mode: 'code', model: 'test-model' },
        repository: { type: 'github', repo: 'Kilo-Org/cloud' },
        workspace: { sandboxId: 'usr-abcdef123419', workspacePath: directory },
      });
      const wrapperInstanceId = crypto.randomUUID();
      const authorization: SessionOperationAuthorization = {
        operation: 'session.prompt',
        operationId: messageId,
        messageId,
        session: { sessionId, kiloSessionId: rootKiloSessionId, directory },
        wrapperInstanceId,
        dispatchDeadlineAt: Date.now() + 60_000,
      };
      const promptProof = (): SessionOperationProof => ({ authorization, dispatched: true });
      const staleActivityAt = () => Date.now() - DEADLINE_MS.kiloInactivity - 1;
      const record = (recoveryAttempts?: number): SessionMessageRecord => ({
        version: 2,
        messageId,
        state: 'accepted',
        acceptedAt: staleActivityAt(),
        lastActivityAt: staleActivityAt(),
        wrapperInstanceId,
        operations: { prompt: promptProof() },
        ...(recoveryAttempts !== undefined ? { recoveryAttempts } : {}),
        intent: {
          turn: { type: 'prompt', messageId, prompt: 'keep the typed message' },
          agent: { mode: 'code', model: 'test-model' },
        },
      });

      const control = {
        getStatus: vi.fn(async () => ({
          connection: 'ready',
          physical: 'running',
          wrapperInstanceId,
        })),
        request: vi.fn(async () => ({
          type: 'response',
          requestId: 'no_output_recovery',
          ok: true,
          result: { status: 'aborted' },
        })),
        quarantineRuntime: vi.fn(async () => ({
          quarantined: true,
          disposition: 'native_retired',
        })),
      };
      const originalEnv = instance['env'];
      Object.assign(instance, {
        env: { ...originalEnv, SANDBOX_CONTROL: { getByName: () => control } },
        // The operation receipt is liveness, not progress: hold it at `running`
        // so the alarm takes the accepted-operation branch and reaches the
        // inactivity bound.
        observeAcceptedOperation: vi.fn(async () => 'running' as const),
      });
      const messages = () => state.storage.kv.get<SessionMessageRecord[]>('session_messages') ?? [];
      const failedEvents = () =>
        drizzle(state.storage)
          .select()
          .from(events)
          .all()
          .filter(event => event.stream_event_type === 'cloud.message.failed');
      try {
        // First detection: the accepted turn has produced no activity past the bound.
        state.storage.kv.put('session_messages', [record()]);
        await instance.alarm();
        await state.storage.deleteAlarm();

        const recovered = messages()[0];
        if (!recovered) throw new Error('Missing recovered record');
        expect(recovered).toMatchObject({
          messageId,
          state: 'queued',
          recoveryAttempts: 1,
          failedReason: undefined,
        });
        // The typed turn survives under its durable identity, while the
        // ambiguous dispatch state is dropped so a fresh runtime can take it.
        expect(recovered.intent).toEqual({
          turn: { type: 'prompt', messageId, prompt: 'keep the typed message' },
          agent: { mode: 'code', model: 'test-model' },
        });
        expect(recovered.wrapperInstanceId).toBeUndefined();
        expect(recovered.operations).toBeUndefined();
        expect(recovered.acceptedAt).toBeUndefined();
        expect(recovered.lastActivityAt).toBeUndefined();
        expect(failedEvents()).toHaveLength(0);

        // Second identical detection on the replacement runtime: terminal.
        state.storage.kv.put('session_messages', [record(1)]);
        await instance.alarm();
        await state.storage.deleteAlarm();

        const terminal = messages()[0];
        if (!terminal) throw new Error('Missing terminal record');
        expect(terminal).toMatchObject({
          messageId,
          state: 'failed',
          failedReason: 'accepted_overdue',
          failedDetail: 'Turn did not complete',
          recoveryAttempts: 1,
        });
        const persistedFailed = failedEvents();
        expect(persistedFailed).toHaveLength(1);
        expect(JSON.parse(persistedFailed[0]?.payload ?? '{}')).toMatchObject({
          messageId,
          status: 'failed',
          reason: 'accepted_overdue',
          attempts: 2,
        });
      } finally {
        Object.assign(instance, { env: originalEnv });
        await state.storage.deleteAlarm();
      }
    });
  });
});
