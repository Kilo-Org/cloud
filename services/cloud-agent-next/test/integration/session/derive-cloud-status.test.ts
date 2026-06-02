import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
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

describe('deriveCloudStatus (/stream connected bootstrap)', () => {
  it('reports preparing for an unprepared session with durable pending queued work', async () => {
    const sessionId = 'agent_cloud_status_derive_queued';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

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
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const cloudStatus = await runInDurableObject(stub, async instance =>
      asCloudStatusDerivingInstance(instance).deriveCloudStatus()
    );

    expect(cloudStatus).toBeNull();
  });

  it('reports ready for a prepared session without current runtime execution', async () => {
    const sessionId = 'agent_cloud_status_derive_ready';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

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
