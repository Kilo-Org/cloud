import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getWrapperLease } from '../../../src/session/wrapper-runtime-state.js';
import { queueUserMessageInput, registerReadySession } from '../../helpers/session-setup.js';

async function clearSessions(): Promise<void> {
  const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
  await Promise.all(
    ids.map(id =>
      runInDurableObject(env.CLOUD_AGENT_SESSION.get(id), instance =>
        instance.ctx.storage.deleteAll()
      )
    )
  );
}

describe('Code Reviewer ephemeral sandbox lifecycle', () => {
  beforeEach(async () => {
    await clearSessions();
  });

  it('schedules post-terminal cleanup and rejects follow-up messages for review sandboxes', async () => {
    const userId = 'user_crv_enabled';
    const sessionId = 'agent_crv_enabled';
    const orgId = 'org_crv_enabled';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId,
        createdOnPlatform: 'code-review',
        prompt: 'review terminal cleanup',
        mode: 'code',
        model: 'test-model',
        sandboxId: 'crv-123456789abc',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_crv_enabled',
        wrapperRunId: 'wr_crv_enabled',
      });
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_crv_enabled', instanceGeneration: 1 },
      });

      await instance.handleWrapperTerminalEvent({
        wrapperRunId: 'wr_crv_enabled',
        status: 'completed',
        messageIds: [],
      });

      return {
        cleanupScheduled: await instance.isSandboxCleanupScheduled(),
        lease: await getWrapperLease(instance.ctx.storage),
        admission: await instance.admitSubmittedMessage(
          queueUserMessageInput({
            userId,
            prompt: 'must not queue while cleanup is scheduled',
            messageId: 'msg_018f1e2d3c4bCrvRejectABCDE',
          })
        ),
        destroyAfter: await instance.ctx.storage.get<number>('ephemeral_sandbox_destroy_after'),
        alarm: await instance.ctx.storage.getAlarm(),
      };
    });

    expect(result.cleanupScheduled).toBe(true);
    expect(result.lease).toMatchObject({ state: 'stop_needed', reason: 'terminal-ended' });
    expect(result.admission).toEqual({
      success: false,
      code: 'BAD_REQUEST',
      error: 'Session sandbox cleanup is scheduled',
    });
    expect(result.destroyAfter).toEqual(expect.any(Number));
    expect(result.alarm).toBeLessThanOrEqual(result.destroyAfter!);
  });

  it.each([
    {
      status: 'failed' as const,
      expectedStopReason: 'terminal-failed' as const,
      userId: 'user_crv_failed',
      sessionId: 'agent_crv_failed',
      wrapperRunId: 'wr_crv_failed',
      connectionId: 'conn_crv_failed',
      instanceId: 'instance_crv_failed',
      messageId: 'msg_018f1e2d3c4bCrvFailedABCD',
      sandboxId: 'crv-fa11ed123456',
    },
    {
      status: 'interrupted' as const,
      expectedStopReason: 'terminal-interrupted' as const,
      userId: 'user_crv_interrupted',
      sessionId: 'agent_crv_interrupted',
      wrapperRunId: 'wr_crv_interrupted',
      connectionId: 'conn_crv_interrupted',
      instanceId: 'instance_crv_interrupted',
      messageId: 'msg_018f1e2d3c4bCrvInterrupted',
      sandboxId: 'crv-1e7e22123abc',
    },
  ])(
    'schedules post-terminal cleanup after $status events for review sandboxes',
    async ({
      status,
      expectedStopReason,
      userId,
      sessionId,
      wrapperRunId,
      connectionId,
      instanceId,
      messageId,
      sandboxId,
    }) => {
      const orgId = `org_crv_${status}`;
      const stub = env.CLOUD_AGENT_SESSION.get(
        env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
      );

      const result = await runInDurableObject(stub, async instance => {
        await registerReadySession(instance, {
          sessionId,
          userId,
          orgId,
          createdOnPlatform: 'code-review',
          prompt: `review ${status} cleanup`,
          mode: 'code',
          model: 'test-model',
          sandboxId,
        });
        await instance.ctx.storage.put('wrapper_runtime_state', {
          wrapperGeneration: 1,
          wrapperConnectionId: connectionId,
          wrapperRunId,
        });
        await instance.ctx.storage.put('wrapper_lease', {
          state: 'owns_wrapper',
          nextInstanceGeneration: 2,
          instance: { instanceId, instanceGeneration: 1 },
        });

        await instance.handleWrapperTerminalEvent({
          wrapperRunId,
          status,
          messageIds: [],
        });

        return {
          cleanupScheduled: await instance.isSandboxCleanupScheduled(),
          lease: await getWrapperLease(instance.ctx.storage),
          admission: await instance.admitSubmittedMessage(
            queueUserMessageInput({
              userId,
              prompt: 'must not queue after terminal cleanup is scheduled',
              messageId,
            })
          ),
          destroyAfter: await instance.ctx.storage.get<number>('ephemeral_sandbox_destroy_after'),
          alarm: await instance.ctx.storage.getAlarm(),
        };
      });

      expect(result.cleanupScheduled).toBe(true);
      expect(result.lease).toMatchObject({ state: 'stop_needed', reason: expectedStopReason });
      expect(result.admission).toEqual({
        success: false,
        code: 'BAD_REQUEST',
        error: 'Session sandbox cleanup is scheduled',
      });
      expect(result.destroyAfter).toEqual(expect.any(Number));
      expect(result.alarm).toBeLessThanOrEqual(result.destroyAfter!);
    }
  );

  it('keeps legacy shared-sandbox reviews warm when the allocated sandbox is not ephemeral', async () => {
    const userId = 'user_crv_shared';
    const sessionId = 'agent_crv_shared';
    const orgId = 'org_crv_shared';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId,
        createdOnPlatform: 'code-review',
        prompt: 'review allocated to a legacy shared sandbox',
        mode: 'code',
        model: 'test-model',
        sandboxId: 'org-123456789abc',
      });
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn_crv_shared',
        wrapperRunId: 'wr_crv_shared',
      });
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'owns_wrapper',
        nextInstanceGeneration: 2,
        instance: { instanceId: 'instance_crv_shared', instanceGeneration: 1 },
      });

      await instance.handleWrapperTerminalEvent({
        wrapperRunId: 'wr_crv_shared',
        status: 'completed',
        messageIds: [],
      });

      return {
        cleanupScheduled: await instance.isSandboxCleanupScheduled(),
        lease: await getWrapperLease(instance.ctx.storage),
        admission: await instance.admitSubmittedMessage(
          queueUserMessageInput({
            userId,
            prompt: 'follow-up remains allowed for shared sandbox',
            messageId: 'msg_018f1e2d3c4bCrvSharedABCDE',
          })
        ),
        destroyAfter: await instance.ctx.storage.get('ephemeral_sandbox_destroy_after'),
      };
    });

    expect(result.cleanupScheduled).toBe(false);
    expect(result.lease).toMatchObject({
      state: 'owns_wrapper',
      keepWarmUntil: expect.any(Number),
    });
    expect(result.admission).toMatchObject({
      success: true,
      outcome: 'queued',
      messageId: 'msg_018f1e2d3c4bCrvSharedABCDE',
    });
    expect(result.destroyAfter).toBeUndefined();
  });

  it('destroys review sandboxes when the scheduled delay expires', async () => {
    const userId = 'user_crv_destroy';
    const sessionId = 'agent_crv_destroy';
    const orgId = 'org_crv_destroy';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      let destroyCalls = 0;
      instance['ephemeralSandboxDestroyer'] = async () => {
        destroyCalls += 1;
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        orgId,
        createdOnPlatform: 'code-review',
        prompt: 'review destroy',
        mode: 'code',
        model: 'test-model',
        sandboxId: 'crv-abcdef123456',
      });
      await instance.ctx.storage.put('ephemeral_sandbox_destroy_after', Date.now() - 1);

      await instance.alarm();

      return {
        destroyCalls,
        destroyAfter: await instance.ctx.storage.get('ephemeral_sandbox_destroy_after'),
        destroyedAt: await instance.ctx.storage.get('ephemeral_sandbox_destroyed_at'),
        cleanupScheduled: await instance.isSandboxCleanupScheduled(),
      };
    });

    expect(result.destroyCalls).toBe(1);
    expect(result.destroyAfter).toBeUndefined();
    expect(result.destroyedAt).toEqual(expect.any(Number));
    expect(result.cleanupScheduled).toBe(true);
  });
});
