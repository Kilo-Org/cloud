import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  allocateWrapperRuntimeState,
  getWrapperRuntimeState,
} from '../../../src/session/wrapper-runtime-state.js';
import {
  getSessionMessageState,
  putSessionMessageState,
} from '../../../src/session/session-message-state.js';
import { registerReadySession } from '../../helpers/session-setup.js';
import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import { RUNTIME_PROXY_GRANT_KEY } from '../../../src/runtime-credential-proxy.js';
import { RUNTIME_AUTHORIZATION_KEY } from '../../../src/session/runtime-authorization-persistence.js';

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

  it('keeps queued work fenced and never retires or replaces expired authority', async () => {
    const userId = 'user_recovery_queued';
    const sessionId = 'agent_recovery_queued';
    const oldAuthorization: RuntimeAuthorization = {
      version: 1,
      id: '00000000-0000-4000-8000-000000000101',
      resourceKind: 'cloud-agent-next',
      resourceId: sessionId,
      userId,
      authorizationUserId: userId,
      issuedAt: '2026-01-01T00:00:00.000Z',
      delegationExpiresAt: '2026-01-02T00:00:00.000Z',
      state: 'active',
      bindings: {
        userPepperDigest: 'a'.repeat(64),
        authorizationPepperDigest: 'b'.repeat(64),
        userMembershipId: 'membership_1',
        authorizationUserMembershipId: 'membership_1',
      },
      source: { admissionSource: 'user' },
    };
    const fresh = {
      ...oldAuthorization,
      id: '00000000-0000-4000-8000-000000000102',
      issuedAt: '2026-01-03T00:00:00.000Z',
      delegationExpiresAt: '2026-01-04T00:00:00.000Z',
    };
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );
    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        kiloSessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        prompt: 'initial prompt',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'expired-cached-token',
      });
      await instance.ctx.storage.put(RUNTIME_AUTHORIZATION_KEY, oldAuthorization);
      await instance.ctx.storage.put(RUNTIME_PROXY_GRANT_KEY, { cached: 'old-grant' });
      await putSessionMessageState(instance.ctx.storage, {
        messageId: 'msg_018f1e2d3c4babcdefghijklmN',
        status: 'queued',
        prompt: 'queued',
        createdAt: Date.now(),
      });
      let stops = 0;
      instance['physicalWrapperStopper'] = async () => {
        stops += 1;
        return { status: 'absent' };
      };
      const secret =
        typeof env.NEXTAUTH_SECRET === 'string'
          ? env.NEXTAUTH_SECRET
          : await env.NEXTAUTH_SECRET.get();
      const outcome = await instance.recoverExpiredRuntimeAuthorization({
        ownerId: userId,
        expectedOldId: oldAuthorization.id,
        recoveryId: '00000000-0000-4000-8000-000000000103',
        runtimeAuthorizationSeal: await sealRuntimeAuthorization(fresh, secret),
        runtimeToken: 'fresh-cached-token',
      });
      return {
        outcome,
        stops,
        authorization: await instance.ctx.storage.get(RUNTIME_AUTHORIZATION_KEY),
        grant: await instance.ctx.storage.get(RUNTIME_PROXY_GRANT_KEY),
      };
    });
    expect(result.outcome).toEqual({ status: 'busy' });
    expect(result.stops).toBe(0);
    expect(result.authorization).toMatchObject({ id: oldAuthorization.id });
    expect(result.grant).toEqual({ cached: 'old-grant' });
  });

  it('persists raw root idle without using it as a success boundary', async () => {
    const userId = 'user_idle_no_fallback';
    const sessionId = 'agent_idle_no_fallback';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

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
