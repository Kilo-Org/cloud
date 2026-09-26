import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessage } from '../../src/sandbox-session/session-message-queue.js';

const organizationId = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ valid: true }));
});

afterEach(async () => {
  await reset();
  vi.restoreAllMocks();
});

/**
 * Incident path: a session was previously attached to another wrapper. The
 * currently bound wrapper takes the attach dispatch, which fails in transport
 * and leaves no receipt, so reconciliation reports `missing`. Delivery must
 * retire that unconfirmed proof and dispatch a fresh attach in the same pass
 * instead of terminalizing the message.
 */
describe('sandbox attach recovery after a replaced wrapper runtime', () => {
  it('retires an attach the replacement runtime never saw and dispatches a fresh attach in the same delivery', async () => {
    const userId = 'user_attach_recovery';
    const sessionId = 'workspace_attach_recovery';
    const sandboxId = 'ses-11111111111141118111111111111111';
    const previousWrapperInstanceId = '11111111-1111-4111-8111-111111111111';
    const wrapperInstanceId = '22222222-2222-4222-8222-222222222222';
    const messageId = 'msg_018f1e2d3c4bAttachRecoverAb';
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);

    const result = await runInDurableObject(stub, async instance => {
      const requests: string[] = [];
      let attachAttempts = 0;
      const control = {
        getStatus: async () => ({
          allocationIncarnation: 'incarnation_1',
          physical: 'running' as const,
          connection: 'ready' as const,
          wrapperInstanceId,
          operationResults: true as const,
        }),
        ensureReady: async () => ({
          allocationIncarnation: 'incarnation_1',
          physical: 'running' as const,
          connection: 'ready' as const,
          wrapperInstanceId,
          operationResults: true as const,
          attachment: {
            directory: '/workspace/attach-recovery',
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
        getRuntimeCredentialProxyFence: async () => null,
        attachSession: async () => ({}),
        request: async (request: { operation: string }) => {
          requests.push(request.operation);
          if (request.operation === 'session.attach') {
            attachAttempts += 1;
            // The first attach reaches the transport but its acknowledgement is
            // lost, so the dispatch proof stays dispatched with no result.
            if (attachAttempts === 1)
              throw new Error('transport failure before the attach was acknowledged');
            return {
              type: 'response' as const,
              requestId: 'attach',
              ok: true as const,
              result: { attached: true },
            };
          }
          if (request.operation === 'session.operation.get')
            return {
              type: 'response' as const,
              requestId: 'lookup',
              ok: true as const,
              result: { state: 'missing' },
            };
          if (request.operation === 'session.prompt')
            return {
              type: 'response' as const,
              requestId: 'prompt',
              ok: true as const,
              result: { messageId, status: 'accepted' },
            };
          throw new Error(`Unexpected control request: ${request.operation}`);
        },
      };
      instance['env'].SANDBOX_CONTROL = { getByName: () => control } as never;

      expect(
        await instance.registerSession({
          identity: { sessionId, userId, orgId: organizationId },
          auth: {
            kiloSessionId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
            kilocodeToken: 'control-token',
          },
          agent: { mode: 'code', model: 'test-model' },
          workspace: { sandboxId, workspacePath: '/workspace/attach-recovery' },
        })
      ).toEqual({ success: true });
      // The session was attached to the runtime that has since been replaced.
      // The control socket now reports the replacement identity, so delivery
      // must prepare (attach) the replacement before it can deliver the prompt.
      instance['terminalLifecycle'].recordAttachment({
        metadata: (await instance.getMetadata())!,
        sandboxId,
        wrapperInstanceId: previousWrapperInstanceId,
        epoch: instance['terminalLifecycle'].captureEpoch() ?? 0,
      });
      const previousAttachment = instance['terminalLifecycle'].getAttachedWrapperInstanceId();

      const admitted = await instance.admitSubmittedMessage({
        userId,
        turn: { type: 'prompt', id: messageId, prompt: 'recover me' },
      });
      // Admission schedules the first dispatch itself; joining it makes the
      // transport failure settle before the retry pass runs.
      await instance['dispatchQueued'](messageId, { allowCreate: true });
      const afterFailure = instance['loadMessages']().find(
        (message: SessionMessage) => message.messageId === messageId
      );

      // The retryable transport failure arms a queue retry but stores no
      // message-level backoff, so driving the second pass directly is the
      // honest retry path rather than a shortcut around it.
      await instance['dispatchQueued'](messageId, { allowCreate: true });
      const stored = instance['loadMessages']().find(
        (message: SessionMessage) => message.messageId === messageId
      );

      return { previousAttachment, admitted, afterFailure, stored, requests };
    });

    expect(result.previousAttachment).toBe(previousWrapperInstanceId);
    expect(result.admitted).toMatchObject({ success: true, outcome: 'queued' });
    expect(result.afterFailure).toMatchObject({
      state: { kind: 'queued', unresolvedDispatch: true },
      proofs: { attach: { dispatched: true } },
    });
    expect(result.afterFailure?.proofs?.attach).not.toHaveProperty('result');

    // The retry reconciles the dispatched attach against the replacement
    // runtime, retires the unconfirmed proof, and lands a fresh attach plus the
    // prompt in the same delivery.
    expect(result.requests).toEqual([
      'session.attach',
      'session.operation.get',
      'session.attach',
      'session.prompt',
    ]);

    expect(result.stored).toMatchObject({ state: { kind: 'accepted' } });
    expect(result.stored?.state).not.toHaveProperty('reason');
    expect(result.stored?.state).not.toHaveProperty('unresolvedDispatch');
    expect(result.stored?.proofs?.retiredAttach).toMatchObject({
      dispatched: true,
      authorization: { operationId: result.afterFailure?.state.preparationAttemptId },
    });
    expect(result.stored?.proofs?.retiredAttach?.completedAt).toBeUndefined();
    expect(result.stored?.proofs?.attach).toMatchObject({
      dispatched: true,
      completedAt: expect.any(Number),
    });
  });
});
