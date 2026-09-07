import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, it, expect } from 'vitest';
import type { CloudStatusData } from '../../../src/shared/protocol.js';
import {
  storePendingSessionMessage,
  type PendingSessionMessage,
} from '../../../src/session/pending-messages.js';
import { groupedRegisterSessionInput, registerReadySession } from '../../helpers/session-setup.js';

type CloudStatusDerivingInstance = {
  deriveCloudStatus(): Promise<CloudStatusData['cloudStatus'] | null>;
};

function asCloudStatusDerivingInstance(instance: object): CloudStatusDerivingInstance {
  const maybe = instance as { deriveCloudStatus?: unknown };
  if (typeof maybe.deriveCloudStatus !== 'function') {
    throw new Error('deriveCloudStatus not found on CloudAgentSession instance');
  }
  return instance as unknown as CloudStatusDerivingInstance;
}

const MSG_INITIAL_PENDING = 'msg_018f1e2d3c4bAaBbCcDdEeFfHh';
const userId = 'user_cloud_status_derive';

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

describe('deriveCloudStatus (/stream connected bootstrap)', () => {
  it('reports preparing for an unprepared session with durable pending queued work', async () => {
    const sessionId = 'agent_cloud_status_derive_queued';
    const stub = sessionStub(userId, sessionId);

    const message: PendingSessionMessage = {
      messageId: MSG_INITIAL_PENDING,
      role: 'user',
      content: 'initial queued prompt',
      createdAt: 1700000000000,
    };

    const cloudStatus = await runInDurableObject(stub, async instance => {
      const result = await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: message.content,
          mode: 'code',
          model: 'claude',
          initialMessageId: message.messageId,
        })
      );
      expect(result.success).toBe(true);

      await storePendingSessionMessage(instance.ctx.storage, message);

      return asCloudStatusDerivingInstance(instance).deriveCloudStatus();
    });

    expect(cloudStatus).toEqual({ type: 'preparing' });
  });

  it('returns null for a brand-new unprepared session without pending queued work', async () => {
    const sessionId = 'agent_cloud_status_derive_empty';
    const stub = sessionStub(userId, sessionId);

    const cloudStatus = await runInDurableObject(stub, async instance =>
      asCloudStatusDerivingInstance(instance).deriveCloudStatus()
    );

    expect(cloudStatus).toBeNull();
  });

  it('reports ready for a prepared session without current runtime execution', async () => {
    const sessionId = 'agent_cloud_status_derive_ready';
    const stub = sessionStub(userId, sessionId);

    const cloudStatus = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared prompt',
        mode: 'code',
        model: 'claude',
      });

      return asCloudStatusDerivingInstance(instance).deriveCloudStatus();
    });

    expect(cloudStatus).toEqual({ type: 'ready' });
  });
});
