import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { sealRuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
import { RUNTIME_PROXY_GRANT_KEY } from '../../src/runtime-credential-proxy.js';
import {
  RUNTIME_AUTHORIZATION_KEY,
  RUNTIME_AUTHORIZATION_RECOVERY_KEY,
} from '../../src/session/runtime-authorization-persistence.js';
import {
  allocateWrapperRuntimeState,
  getWrapperRuntimeState,
} from '../../src/session/wrapper-runtime-state.js';
import { registerReadySession } from '../helpers/session-setup.js';

const organizationId = '11111111-1111-4111-8111-111111111111';

function authorization(input: {
  id: string;
  sessionId: string;
  userId: string;
  expiresAt: string;
  issuedAt?: string;
  state?: 'active' | 'revoked';
}): RuntimeAuthorization {
  return {
    version: 1,
    id: input.id,
    resourceKind: 'cloud-agent-next',
    resourceId: input.sessionId,
    userId: input.userId,
    authorizationUserId: input.userId,
    organizationId,
    issuedAt: input.issuedAt ?? new Date(Date.now() - 60_000).toISOString(),
    delegationExpiresAt: input.expiresAt,
    state: input.state ?? 'active',
    bindings: {
      userPepperDigest: 'a'.repeat(64),
      authorizationPepperDigest: 'b'.repeat(64),
      userMembershipId: 'membership_1',
      authorizationUserMembershipId: 'membership_1',
    },
    source: { admissionSource: 'user' },
  };
}

async function secret() {
  return typeof env.NEXTAUTH_SECRET === 'string' ? env.NEXTAUTH_SECRET : env.NEXTAUTH_SECRET.get();
}

async function seal(value: RuntimeAuthorization) {
  return sealRuntimeAuthorization(value, await secret());
}

async function runtimeToken(value: RuntimeAuthorization) {
  return jwt.sign({ runtimeAuthorization: { id: value.id } }, await secret(), {
    algorithm: 'HS256',
    expiresIn: '30 minutes',
  });
}

beforeEach(async () => {
  const namespaces = [env.CLOUD_AGENT_SESSION, env.SANDBOX_SESSION];
  await Promise.all(
    namespaces.flatMap(async namespace => {
      const ids = await listDurableObjectIds(namespace);
      return Promise.all(
        ids.map(id =>
          runInDurableObject(namespace.get(id), instance => instance.ctx.storage.deleteAll())
        )
      );
    })
  );
});

describe('runtime authorization recovery', () => {
  it('recovers an expired CloudAgentSession authorization only after confirmed idle retirement', async () => {
    const userId = 'user_cloud_recovery';
    const sessionId = 'agent_cloud_recovery';
    const old = authorization({
      id: '00000000-0000-4000-8000-000000000101',
      sessionId,
      userId,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      issuedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    const fresh = authorization({
      id: '00000000-0000-4000-8000-000000000102',
      sessionId,
      userId,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: organizationId,
        kiloSessionId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        prompt: 'initial',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'expired-token',
      });
      const previousRuntime = await allocateWrapperRuntimeState(instance.ctx.storage);
      await instance.ctx.storage.put(RUNTIME_AUTHORIZATION_KEY, old);
      await instance.ctx.storage.put(RUNTIME_PROXY_GRANT_KEY, { cached: 'old-grant' });
      const stops: string[] = [];
      instance['physicalWrapperStopper'] = async request => {
        stops.push(request.reason);
        return { status: 'absent' };
      };
      instance['physicalWrapperObserver'] = async () => ({ status: 'absent' });

      const outcome = await instance.recoverExpiredRuntimeAuthorization({
        ownerId: userId,
        expectedOldId: old.id,
        recoveryId: '00000000-0000-4000-8000-000000000103',
        runtimeAuthorizationSeal: await seal(fresh),
        runtimeToken: 'fresh-token',
      });
      return {
        outcome,
        stops,
        metadata: await instance.getMetadata(),
        authorization: await instance.ctx.storage.get(RUNTIME_AUTHORIZATION_KEY),
        grant: await instance.ctx.storage.get(RUNTIME_PROXY_GRANT_KEY),
        recovery: await instance.ctx.storage.get(RUNTIME_AUTHORIZATION_RECOVERY_KEY),
        runtime: await getWrapperRuntimeState(instance.ctx.storage),
        previousRuntime: previousRuntime.state,
      };
    });

    expect(result.outcome).toEqual({ status: 'recovered' });
    expect(result.stops).toEqual(['idle-timeout']);
    expect(result.metadata).toMatchObject({
      identity: { userId, sessionId, orgId: organizationId },
      auth: { kilocodeToken: 'fresh-token' },
    });
    expect(result.authorization).toMatchObject({ id: fresh.id, state: 'active' });
    expect(result.grant).toBeUndefined();
    expect(result.recovery).toBeUndefined();
    expect(result.runtime).toEqual({
      wrapperGeneration: result.previousRuntime.wrapperGeneration + 1,
    });
  });

  it('denies revoked seals and foreign owners and keeps queued work busy', async () => {
    const userId = 'user_cloud_recovery_guards';
    const sessionId = 'agent_cloud_recovery_guards';
    const old = authorization({
      id: '00000000-0000-4000-8000-000000000201',
      sessionId,
      userId,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      issuedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    const fresh = authorization({
      id: '00000000-0000-4000-8000-000000000202',
      sessionId,
      userId,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const outcomes = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId: organizationId,
        prompt: 'initial',
        mode: 'code',
        model: 'test-model',
      });
      await instance.ctx.storage.put(RUNTIME_AUTHORIZATION_KEY, old);
      const input = {
        ownerId: userId,
        expectedOldId: old.id,
        recoveryId: '00000000-0000-4000-8000-000000000203',
        runtimeAuthorizationSeal: await seal(fresh),
        runtimeToken: 'fresh-token',
      };
      const foreign = await instance.recoverExpiredRuntimeAuthorization({
        ...input,
        ownerId: 'other',
      });
      const revoked = await instance.recoverExpiredRuntimeAuthorization({
        ...input,
        runtimeAuthorizationSeal: await seal({ ...fresh, state: 'revoked' }),
      });
      await instance.admitSubmittedMessage({
        userId,
        turn: { type: 'prompt', id: 'msg_018f1e2d3c4bBusyRecoveryAb', prompt: 'queued' },
      });
      const busy = await instance.recoverExpiredRuntimeAuthorization(input);
      return { foreign, revoked, busy };
    });

    expect(outcomes).toEqual({
      foreign: { status: 'denied' },
      revoked: { status: 'denied' },
      busy: { status: 'busy' },
    });
  });

  it('retires an idle SandboxSession runtime, clears its attachment fence, and reattaches on dispatch', async () => {
    const userId = 'user_sandbox_recovery';
    const sessionId = 'workspace_sandbox_recovery';
    const sandboxId = 'ses-11111111111141118111111111111111';
    const wrapperInstanceId = '22222222-2222-4222-8222-222222222222';
    const old = authorization({
      id: '00000000-0000-4000-8000-000000000301',
      sessionId,
      userId,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      issuedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    });
    const fresh = authorization({
      id: '00000000-0000-4000-8000-000000000302',
      sessionId,
      userId,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);

    const result = await runInDurableObject(stub, async instance => {
      const requests: string[] = [];
      let retirementAttempts = 0;
      const control = {
        getStatus: async () => ({
          physical: 'running' as const,
          connection: 'ready' as const,
          work: 'idle' as const,
          wrapperInstanceId,
          runtimeRecovery: true as const,
        }),
        getRuntimeCredentialProxyFence: async () => ({
          allocationId: 'allocation_1',
          plane: 'control' as const,
          providerInstanceId: 'provider_1',
          connectionId: 'connection_1',
          wrapperInstanceId,
        }),
        request: async (request: { operation: string; payload?: unknown }) => {
          requests.push(request.operation);
          if (request.operation === 'session.runtime.retire') {
            retirementAttempts += 1;
            if (retirementAttempts === 1) throw new Error('retirement acknowledgement lost');
            return {
              type: 'response' as const,
              requestId: 'retire',
              ok: true as const,
              result: {
                retired: true,
                recoveryId: (request.payload as { recoveryId: string }).recoveryId,
              },
            };
          }
          if (request.operation === 'session.attach') {
            return {
              type: 'response' as const,
              requestId: 'attach',
              ok: true as const,
              result: { attached: true },
            };
          }
          return {
            type: 'response' as const,
            requestId: 'prompt',
            ok: true as const,
            result: { messageId: 'msg_018f1e2d3c4bFreshDispatchAb', status: 'accepted' },
          };
        },
        ensureReady: async () => ({
          physical: 'running' as const,
          connection: 'ready' as const,
          wrapperInstanceId,
          attachment: {
            directory: '/workspace/recovery',
            env: { KILOCODE_TOKEN: 'control-token' },
            kilo: {
              scopeId: sessionId,
              token: 'control-token',
              targets: {
                backendBaseUrl: 'https://backend.example.test',
                providerBaseUrl: 'https://provider.example.test',
                sessionIngestBaseUrl: 'https://ingest.example.test',
              },
            },
          },
        }),
        attachSession: async () => ({}),
      };
      instance['env'].SANDBOX_CONTROL = { getByName: () => control } as never;
      instance['env'].WORKER_URL = 'https://worker.example.test';
      expect(
        await instance.registerSession({
          identity: { sessionId, userId, orgId: organizationId },
          auth: {
            kiloSessionId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
            kilocodeToken: 'expired-token',
          },
          runtimeAuthorizationSeal: await seal(old),
          agent: { mode: 'code', model: 'test-model' },
          workspace: { sandboxId, workspacePath: '/workspace/recovery' },
        })
      ).toEqual({ success: true });
      instance['terminalLifecycle'].recordAttachment({
        metadata: (await instance.getMetadata())!,
        sandboxId,
        wrapperInstanceId,
        epoch: 0,
      });
      instance.ctx.storage.kv.put(RUNTIME_PROXY_GRANT_KEY, { cached: 'old-grant' });
      const recoveryInput = {
        ownerId: userId,
        expectedOldId: old.id,
        recoveryId: '00000000-0000-4000-8000-000000000303',
        runtimeAuthorizationSeal: await seal(fresh),
        runtimeToken: await runtimeToken(fresh),
      };
      const lostAcknowledgement = await instance.recoverExpiredRuntimeAuthorization(recoveryInput);
      const retainedRecovery = instance.ctx.storage.kv.get(RUNTIME_AUTHORIZATION_RECOVERY_KEY);
      const recovered = await instance.recoverExpiredRuntimeAuthorization(recoveryInput);
      const afterRecovery = {
        metadata: await instance.getMetadata(),
        authorization: instance.ctx.storage.kv.get(RUNTIME_AUTHORIZATION_KEY),
        grant: instance.ctx.storage.kv.get(RUNTIME_PROXY_GRANT_KEY),
        attachment: instance['terminalLifecycle'].getAttachedWrapperInstanceId(),
      };
      const admitted = await instance.admitSubmittedMessage({
        userId,
        turn: {
          type: 'command',
          id: 'msg_018f1e2d3c4bFreshDispatchAb',
          command: 'status',
          arguments: '',
        },
      });
      await instance['dispatchQueued']('msg_018f1e2d3c4bFreshDispatchAb', { allowCreate: true });
      return {
        lostAcknowledgement,
        retainedRecovery,
        recovered,
        afterRecovery,
        admitted,
        requests,
      };
    });

    expect(result.lostAcknowledgement).toEqual({ status: 'retry' });
    expect(result.retainedRecovery).toEqual({
      expectedOldId: old.id,
      recoveryId: '00000000-0000-4000-8000-000000000303',
    });
    expect(result.recovered).toEqual({ status: 'recovered' });
    expect(result.afterRecovery).toMatchObject({
      metadata: { identity: { userId, sessionId, orgId: organizationId } },
      authorization: { id: fresh.id },
    });
    expect(result.afterRecovery.grant).toBeUndefined();
    expect(result.afterRecovery.attachment).toBeUndefined();
    expect(result.admitted).toMatchObject({ success: true, outcome: 'queued' });
    expect(result.requests).toEqual([
      'session.runtime.retire',
      'session.runtime.retire',
      'session.attach',
      'session.prompt',
    ]);
  });
});
