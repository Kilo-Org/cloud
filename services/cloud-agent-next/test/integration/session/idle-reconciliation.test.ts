import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  allocateWrapperRuntimeState,
  getWrapperRuntimeState,
} from '../../../src/session/wrapper-runtime-state.js';
import {
  getSessionMessageState,
  putSessionMessageState,
} from '../../../src/session/session-message-state.js';
import { registerReadySession } from '../../helpers/session-setup.js';

// Registered sessions leave dispatch, alarm, and fire-and-forget publication
// work in the session DO. Interrupt every session a test touched, clear its
// alarm, and drain its publication tail, or that work wakes after this file
// closes and its logs race the vitest worker shutdown as pending
// onUserConsoleLog rejections (EnvironmentTeardownError).
const touchedSessions = new Set<string>();

function sessionStub(userId: string, sessionId: string) {
  const sessionName = `${userId}:${sessionId}`;
  touchedSessions.add(sessionName);
  return env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName));
}

afterEach(async () => {
  for (const sessionName of touchedSessions) {
    await runInDurableObject(
      env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName)),
      async (instance, state) => {
        try {
          await instance.interruptExecution();
        } catch {
          // A session that never registered has no work to interrupt.
        }
        await state.storage.deleteAlarm();
        const publicationTail = (instance as any).publicExtensionPublicationTail as
          | Promise<unknown>
          | undefined;
        await publicationTail?.catch(() => undefined);
      }
    ).catch(() => undefined);
  }
  touchedSessions.clear();
});

describe('idle lifecycle integration', () => {
  beforeEach(async () => {
    const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
    await Promise.all(
      ids.map(id =>
        runInDurableObject(env.CLOUD_AGENT_SESSION.get(id), instance =>
          instance.ctx.storage.deleteAll()
        )
      )
    );
  });

  it('persists raw root idle without using it as a success boundary', async () => {
    const userId = 'user_idle_no_fallback';
    const sessionId = 'agent_idle_no_fallback';
    const stub = sessionStub(userId, sessionId);

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token-idle-no-fallback',
      });
      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      const messageId = 'msg_018f1e2d3c4bNoIdleFallbkAB';
      await putSessionMessageState(instance.ctx.storage, {
        messageId,
        status: 'accepted',
        prompt: 'remain accepted',
        createdAt: Date.now(),
        acceptedAt: Date.now(),
        wrapperRunId: wrapperState.wrapperRunId,
      });

      const handler = await instance['getIngestHandler']();
      const ws = {
        deserializeAttachment: () => ({
          wrapperRunId: wrapperState.wrapperRunId,
          sessionId,
          connectedAt: Date.now(),
          kiloSessionState: { captured: false },
          lastHeartbeatUpdate: Date.now(),
          lastEventAtUpdate: Date.now(),
          wrapperGeneration: wrapperState.wrapperGeneration,
          wrapperConnectionId: wrapperState.wrapperConnectionId,
        }),
        serializeAttachment: () => {},
        send: () => {},
      } as unknown as WebSocket;

      await handler.handleIngestMessage(
        ws,
        JSON.stringify({
          streamEventType: 'kilocode',
          data: {
            event: 'session.idle',
            properties: { sessionID: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' },
          },
          timestamp: new Date().toISOString(),
        })
      );
      await instance.alarm();

      return {
        message: await getSessionMessageState(instance.ctx.storage, messageId),
        runtime: await getWrapperRuntimeState(instance.ctx.storage),
      };
    });

    expect(result.message?.status).toBe('accepted');
    expect(result.runtime).not.toHaveProperty('lastWrapperIdleAt');
    expect(result.runtime).not.toHaveProperty('idleReconcileAfter');
  });
});
