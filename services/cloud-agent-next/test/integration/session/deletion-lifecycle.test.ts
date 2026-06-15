import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CloudAgentSession } from '../../../src/persistence/CloudAgentSession.js';
import { listPendingSessionMessages } from '../../../src/session/pending-messages.js';
import { getWrapperLease } from '../../../src/session/wrapper-runtime-state.js';
import {
  groupedRegisterSessionInput,
  queueUserMessageInput,
  registerReadySession,
} from '../../helpers/session-setup.js';

async function establishOwnedWrapper(
  instance: CloudAgentSession,
  stopStatus: 'still-present' | 'absent' = 'still-present'
): Promise<void> {
  await instance.ctx.storage.put('wrapper_lease', {
    state: 'owns_wrapper',
    nextInstanceGeneration: 2,
    instance: { instanceId: 'instance_delete', instanceGeneration: 1 },
  });
  instance['physicalWrapperStopper'] = async () =>
    stopStatus === 'absent' ? { status: 'absent' } : { status: 'still-present', observed: [] };
}

describe('session deletion physical cleanup', () => {
  it('erases Durable Object state after explicit deletion confirms wrapper absence', async () => {
    const userId = 'user_delete_complete';
    const sessionId = 'agent_delete_complete';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'delete complete',
        mode: 'code',
        model: 'test-model',
      });
      await establishOwnedWrapper(instance, 'absent');
      await instance.ctx.storage.put('deletion_marker', true);

      await instance.deleteSession();
      return {
        metadata: await instance.getMetadata(),
        marker: await instance.ctx.storage.get('deletion_marker'),
        alarm: await instance.ctx.storage.getAlarm(),
        lease: await getWrapperLease(instance.ctx.storage),
      };
    });

    expect(result).toEqual({
      metadata: null,
      marker: undefined,
      alarm: null,
      lease: { state: 'none', nextInstanceGeneration: 1 },
    });
  });

  it('does not erase Durable Object state when explicit deletion cannot confirm wrapper absence', async () => {
    const userId = 'user_delete_pending';
    const sessionId = 'agent_delete_pending';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'delete pending',
        mode: 'code',
        model: 'test-model',
      });
      await establishOwnedWrapper(instance);

      await expect(instance.deleteSession()).rejects.toThrow(
        'Session deletion pending physical wrapper cleanup'
      );
      const result = {
        metadata: await instance.getMetadata(),
        lease: await getWrapperLease(instance.ctx.storage),
      };
      await instance.ctx.storage.deleteAll();
      return result;
    });

    expect(result.metadata?.identity.sessionId).toBe(sessionId);
    expect(result.lease).toMatchObject({
      state: 'stop_needed',
      reason: 'session-delete',
      attempts: 1,
    });
  });

  it('retains physical cleanup backoff while explicit deletion is pending', async () => {
    const userId = 'user_delete_backoff';
    const sessionId = 'agent_delete_backoff';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'delete backoff',
        mode: 'code',
        model: 'test-model',
      });
      await establishOwnedWrapper(instance);

      await expect(instance.deleteSession()).rejects.toThrow(
        'Session deletion pending physical wrapper cleanup'
      );
      const lease = await getWrapperLease(instance.ctx.storage);
      const alarm = await instance.ctx.storage.getAlarm();
      await instance.ctx.storage.deleteAll();
      return { lease, alarm };
    });

    expect(result.lease).toMatchObject({ state: 'stop_needed', attempts: 1 });
    if (result.lease.state !== 'stop_needed') throw new Error('Expected pending wrapper cleanup');
    expect(result.alarm).toBe(result.lease.nextAttemptAt);
  });

  it('rejects new message admission while explicit deletion is pending', async () => {
    const userId = 'user_delete_reject_admission';
    const sessionId = 'agent_delete_reject_admission';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'delete reject admission',
        mode: 'code',
        model: 'test-model',
      });
      await establishOwnedWrapper(instance);

      await expect(instance.deleteSession()).rejects.toThrow(
        'Session deletion pending physical wrapper cleanup'
      );
      return {
        submittedAdmission: await instance.admitSubmittedMessage(
          queueUserMessageInput({ userId, prompt: 'must not queue after delete' })
        ),
        groupedInitialAdmission: await instance.createSessionWithInitialAdmission({
          ...groupedRegisterSessionInput({
            sessionId,
            userId,
            prompt: 'must not replay grouped initial admission after delete',
            mode: 'code',
            model: 'test-model',
          }),
          message: {
            initialTurn: {
              type: 'prompt',
              messageId: 'msg_018f1e2d3c4bDeleteGroupABC',
              prompt: 'must not replay grouped initial admission after delete',
            },
          },
        }),
        preparedInitialAdmission: await instance.admitPreparedInitialMessage({ userId }),
        registration: await instance.registerSession(
          groupedRegisterSessionInput({
            sessionId,
            userId,
            prompt: 'must not register after delete',
            mode: 'code',
            model: 'test-model',
          })
        ),
        pendingMessages: await listPendingSessionMessages(instance.ctx.storage),
      };
    });

    const deletionPending = {
      success: false,
      code: 'NOT_FOUND',
      error: 'Session deletion is pending',
    };
    expect(result).toEqual({
      submittedAdmission: deletionPending,
      groupedInitialAdmission: deletionPending,
      preparedInitialAdmission: deletionPending,
      registration: { success: false, error: 'Session deletion is pending' },
      pendingMessages: [],
    });
  });

  it('finishes pending explicit deletion from an alarm after wrapper absence is confirmed', async () => {
    const userId = 'user_delete_alarm_complete';
    const sessionId = 'agent_delete_alarm_complete';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'delete alarm complete',
        mode: 'code',
        model: 'test-model',
      });
      await establishOwnedWrapper(instance);
      await instance.ctx.storage.put('deletion_marker', true);
      let stopAttempts = 0;
      instance['physicalWrapperStopper'] = async () => {
        stopAttempts += 1;
        return stopAttempts === 1
          ? { status: 'still-present', observed: [] }
          : { status: 'absent' };
      };

      await expect(instance.deleteSession()).rejects.toThrow(
        'Session deletion pending physical wrapper cleanup'
      );
      const pendingLease = await getWrapperLease(instance.ctx.storage);
      if (pendingLease.state !== 'stop_needed') throw new Error('Expected pending wrapper cleanup');
      await instance.ctx.storage.put('wrapper_lease', {
        ...pendingLease,
        nextAttemptAt: Date.now() - 1,
      });

      await instance.alarm();
      return {
        metadata: await instance.getMetadata(),
        marker: await instance.ctx.storage.get('deletion_marker'),
        alarm: await instance.ctx.storage.getAlarm(),
        lease: await getWrapperLease(instance.ctx.storage),
      };
    });

    expect(result).toEqual({
      metadata: null,
      marker: undefined,
      alarm: null,
      lease: { state: 'none', nextInstanceGeneration: 1 },
    });
  });

  it('postpones retention deletion while physical wrapper cleanup remains unresolved', async () => {
    const userId = 'user_ttl_pending';
    const sessionId = 'agent_ttl_pending';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'ttl pending',
        mode: 'code',
        model: 'test-model',
      });
      await establishOwnedWrapper(instance);
      await instance.ctx.storage.put('last_activity', 1);

      await instance.alarm();
      const result = {
        metadata: await instance.getMetadata(),
        lease: await getWrapperLease(instance.ctx.storage),
      };
      await instance.ctx.storage.deleteAll();
      return result;
    });

    expect(result.metadata?.identity.sessionId).toBe(sessionId);
    expect(result.lease).toMatchObject({
      state: 'stop_needed',
      reason: 'session-delete',
    });
  });

  it('retains physical cleanup backoff while retention deletion is already pending', async () => {
    const userId = 'user_ttl_backoff';
    const sessionId = 'agent_ttl_backoff';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'ttl backoff',
        mode: 'code',
        model: 'test-model',
      });
      const nextAttemptAt = Date.now() + 30_000;
      await instance.ctx.storage.put('wrapper_lease', {
        state: 'stop_needed',
        nextInstanceGeneration: 2,
        target: { kind: 'session' },
        reason: 'session-delete',
        requestedAt: Date.now(),
        nextAttemptAt,
        attempts: 1,
      });
      await instance.ctx.storage.put('last_activity', 1);

      await instance.alarm();
      const result = {
        lease: await getWrapperLease(instance.ctx.storage),
        alarm: await instance.ctx.storage.getAlarm(),
        nextAttemptAt,
      };
      await instance.ctx.storage.deleteAll();
      return result;
    });

    expect(result.lease).toMatchObject({ state: 'stop_needed', attempts: 1 });
    expect(result.alarm).toBe(result.nextAttemptAt);
  });
});
