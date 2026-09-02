import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudAgentQueueReport } from '@kilocode/worker-utils/cloud-agent-queue-report';
import type { CallbackJob } from '../../../src/callbacks/types.js';
import type { CloudAgentSession } from '../../../src/persistence/CloudAgentSession.js';
import { parseSessionMetadata } from '../../../src/persistence/session-metadata.js';
import { listPendingSessionMessages } from '../../../src/session/pending-messages.js';
import { getSessionMessageState } from '../../../src/session/session-message-state.js';
import * as sessionReports from '../../../src/telemetry/session-reports.js';
import * as pg from '../../../src/db/pg.js';
import { resolveSessionStub } from '../../../src/sandbox-session/session-stub.js';
import {
  admitLegacyPreparedInitialMessage,
  replayLegacyPreparedInitialMessageIfAlreadyAdmitted,
} from '../../../src/session/legacy-prepared-admission.js';
import { registerNewSession } from '../../../src/session/session-registration.js';
import type { Env } from '../../../src/types.js';
import {
  groupedRegisterSessionInput,
  queueUserMessageInput,
  registerReadySession,
} from '../../helpers/session-setup.js';

describe('legacy prepare-only compatibility', () => {
  beforeEach(() => {
    vi.spyOn(pg, 'getPgDb').mockImplementation(() => {
      throw new Error('Unexpected PostgreSQL access');
    });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    vi.spyOn(sessionReports, 'createCloudAgentSessionReport').mockResolvedValue(undefined);
    vi.spyOn(sessionReports, 'recordCloudAgentSandboxIdentity').mockResolvedValue(undefined);
    vi.spyOn(sessionReports, 'recordCloudAgentSessionFailure').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('queues the registered code-review turn once under CONTROL_PLANE_IDS=*', async () => {
    const userId = 'user_legacy_review_registration';
    const orgId = '123e4567-e89b-12d3-a456-426614174000';
    const messageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
    const prompt = 'Review the pull request';
    const callbackTarget = { url: 'https://example.com/review-callback' };
    const createSessionForCloudAgent = vi.fn().mockResolvedValue({ created: true });
    const context = {
      userId,
      authToken: 'test-review-token',
      env: {
        CLOUD_AGENT_SESSION: env.CLOUD_AGENT_SESSION,
        SANDBOX_SESSION: env.SANDBOX_SESSION,
        CONTROL_PLANE_IDS: '*',
        NEXTAUTH_SECRET: 'test-secret',
        SESSION_INGEST: { createSessionForCloudAgent } as unknown as Env['SESSION_INGEST'],
      } as Env,
    };
    const registration = await registerNewSession(
      {
        initialTurn: { type: 'prompt', id: messageId, prompt },
        agent: { mode: 'code', model: 'test-model', variant: 'high' },
        repository: { type: 'github', repo: 'acme/repo', branch: 'refs/pull/42/head' },
        profile: {
          overrides: { appendSystemPrompt: 'Review only' },
          resolved: { setupCommands: ['true'] },
        },
        finalization: { autoCommit: false, condenseOnComplete: true, gateThreshold: 'warning' },
        options: {
          kilocodeOrganizationId: orgId,
          createdOnPlatform: 'code-review',
          callbackTarget,
          shallow: true,
        },
      },
      context,
      { billingOrigin: 'code-review' }
    );

    expect(registration.cloudAgentSessionId).toMatch(/^agent_/);
    expect(registration.sandboxId).toMatch(/^crv-[a-f0-9]{48}$/);
    expect(registration.sandboxProvider).toBe('cloudflare');
    expect(createSessionForCloudAgent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: registration.kiloSessionId,
        cloudAgentSessionId: registration.cloudAgentSessionId,
        kiloUserId: userId,
        organizationId: orgId,
        createdOnPlatform: 'code-review',
      })
    );

    const stub = resolveSessionStub(context.env, userId, registration.cloudAgentSessionId);
    await runInDurableObject(stub, async (instance, state) => {
      expect(await listPendingSessionMessages(state.storage)).toEqual([]);
      const metadata = await instance.getMetadata();
      expect(metadata).toMatchObject({
        metadataSchemaVersion: 2,
        identity: { userId, orgId, createdOnPlatform: 'code-review', billingOrigin: 'code-review' },
        initialMessage: { id: messageId, prompt },
        agent: {
          mode: 'code',
          model: 'test-model',
          variant: 'high',
          appendSystemPrompt: 'Review only',
        },
        repository: { type: 'github', repo: 'acme/repo', upstreamBranch: 'refs/pull/42/head' },
        profile: { setupCommands: ['true'] },
        finalization: { autoCommit: false, condenseOnComplete: true, gateThreshold: 'warning' },
        callback: { target: callbackTarget },
        workspace: { sandboxId: registration.sandboxId, shallow: true },
      });
      expect(metadata?.lifecycle.preparedAt).toBeUndefined();
      vi.spyOn(state.storage, 'setAlarm').mockResolvedValue(undefined);
    });

    const admissionInput = { cloudAgentSessionId: registration.cloudAgentSessionId };
    expect(
      await replayLegacyPreparedInitialMessageIfAlreadyAdmitted(admissionInput, context)
    ).toBeUndefined();
    const admission = await admitLegacyPreparedInitialMessage(admissionInput, context);
    expect(admission).toMatchObject({
      cloudAgentSessionId: registration.cloudAgentSessionId,
      messageId,
      delivery: 'queued',
      status: 'started',
    });
    expect(
      await replayLegacyPreparedInitialMessageIfAlreadyAdmitted(admissionInput, context)
    ).toEqual(admission);

    await runInDurableObject(stub, async (instance, state) => {
      const pending = await listPendingSessionMessages(state.storage);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        messageId,
        content: prompt,
        intent: {
          turn: { type: 'prompt', messageId, prompt },
          agent: { mode: 'code', model: 'test-model', variant: 'high' },
          finalization: { autoCommit: false, condenseOnComplete: true },
        },
        callbackSnapshot: { required: true, target: callbackTarget },
      });
      expect(await getSessionMessageState(state.storage, messageId)).toMatchObject({
        messageId,
        status: 'queued',
      });
      expect(
        instance['eventQueries'].findByFilters({ eventTypes: ['cloud.message.queued'] })
      ).toHaveLength(1);
    });
    expect(pg.getPgDb).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(context.env.CONTROL_PLANE_IDS).toBe('*');
  });
});

describe('partial admission callback snapshot recovery', () => {
  it('retains the admission-time callback target when delivery accepts before state repair', async () => {
    const userId = 'user_partial_callback_repair';
    const sessionId = 'agent_partial_callback_repair';
    const messageId = 'msg_018f1e2d3c4bPartCbAbCdEfGh';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      const captured: CallbackJob[] = [];
      (
        instance as unknown as {
          env: { CALLBACK_QUEUE: { send: (job: CallbackJob) => Promise<void> } };
        }
      ).env.CALLBACK_QUEUE = {
        send: async job => {
          captured.push(job);
        },
      };
      (
        instance as unknown as {
          orchestrator: {
            execute: (plan: {
              turn: { messageId: string };
            }) => Promise<{ messageId: string; kiloSessionId: string }>;
          };
        }
      ).orchestrator = {
        execute: async plan => ({ messageId: plan.turn.messageId, kiloSessionId: 'kilo_test' }),
      };
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'prepared',
        mode: 'code',
        model: 'test-model',
        kiloSessionId: '51515151-5151-4515-8515-515151515151',
        kilocodeToken: 'callback-repair-token',
        callbackTarget: { url: 'https://callback.example.com/original' },
      });
      const realPut = instance.ctx.storage.put.bind(instance.ctx.storage);
      let failedQueuedState = false;
      instance.ctx.storage.put = async (key, value) => {
        if (!failedQueuedState && typeof key === 'string' && key.startsWith('session_message:')) {
          failedQueuedState = true;
          throw new Error('queued state unavailable');
        }
        return realPut(key, value);
      };
      const admission = await instance.admitSubmittedMessage(
        queueUserMessageInput({ userId, messageId, prompt: 'callback partial write' })
      );
      instance.ctx.storage.put = realPut;
      const pending = await listPendingSessionMessages(instance.ctx.storage);
      expect(pending).toHaveLength(1);
      expect(admission.success).toBe(false);
      await instance.alarm();
      await (
        instance as unknown as {
          terminalizeSessionMessageOnce: (id: string, params: object) => Promise<unknown>;
        }
      ).terminalizeSessionMessageOnce(messageId, {
        kind: 'completed',
        completionSource: 'assistant_message_event',
      });
      await (
        instance as unknown as {
          finalizeIdleBatchCallbackIfReady: (options: object) => Promise<void>;
        }
      ).finalizeIdleBatchCallbackIfReady({
        allowWithoutObservedIdle: true,
      });
      return { state: await getSessionMessageState(instance.ctx.storage, messageId), captured };
    });

    expect(result.state).toMatchObject({
      callbackRequired: true,
      callbackTarget: { url: 'https://callback.example.com/original' },
    });
    expect(result.captured).toHaveLength(1);
    expect(result.captured[0]?.target.url).toBe('https://callback.example.com/original');
  });
});

const cloneFromKiloSessionId = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const destinationKiloSessionId = 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb';
const firstMessageId = 'msg_018f1e2d3c4bAbCdEfGhIjKlMn';
const secondMessageId = 'msg_018f1e2d3c4bBBBBBBBBBBBBBB';

function cloneRegistrationInput(
  reportingCreatedAt?: string
): Parameters<CloudAgentSession['registerSession']>[0] {
  return {
    ...groupedRegisterSessionInput({
      sessionId: `agent_${crypto.randomUUID()}`,
      userId: 'user_clone_anchor',
      kiloSessionId: destinationKiloSessionId,
      prompt: '',
      mode: 'code',
      model: 'test-model',
    }),
    message: undefined,
    clone: {
      cloneFromKiloSessionId,
      ...(reportingCreatedAt ? { reportingCreatedAt } : {}),
    },
    workspace: { sandboxId: 'usr-123456789abc' },
  };
}

function cloneStub(input: ReturnType<typeof cloneRegistrationInput>) {
  return env.CLOUD_AGENT_SESSION.get(
    env.CLOUD_AGENT_SESSION.idFromName(`${input.identity.userId}:${input.identity.sessionId}`)
  );
}

describe('forward-only clone reporting admission', () => {
  beforeEach(() => {
    vi.spyOn(sessionReports, 'ensureCloneSessionReport').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retains the first admitted ID through rejection, replay, later sends and stale metadata updates', async () => {
    const reportingCreatedAt = new Date().toISOString();
    const input = cloneRegistrationInput(reportingCreatedAt);
    await runInDurableObject(cloneStub(input), async instance => {
      expect(await instance.registerSession(input)).toEqual({ success: true });
      const originalMetadata = await instance.getMetadata();
      expect(originalMetadata?.initialMessage).toBeUndefined();
      const request = queueUserMessageInput({
        userId: input.identity.userId,
        messageId: firstMessageId,
        prompt: 'continue the clone',
      });
      expect(
        await instance.admitSubmittedMessage({
          ...request,
          turn: { type: 'prompt', id: secondMessageId, prompt: '' },
        })
      ).toMatchObject({ success: false, code: 'BAD_REQUEST' });
      expect((await instance.getMetadata())?.initialMessage).toBeUndefined();
      expect(await listPendingSessionMessages(instance.ctx.storage)).toHaveLength(0);

      const admission = await instance.admitSubmittedMessage(request);
      expect(admission).toMatchObject({ success: true, messageId: firstMessageId });
      expect((await instance.getMetadata())?.initialMessage).toEqual({ id: firstMessageId });
      expect(await instance.admitSubmittedMessage(request)).toEqual(admission);
      expect(
        await instance.admitSubmittedMessage({
          ...request,
          turn: { type: 'prompt', id: secondMessageId, prompt: 'second message' },
        })
      ).toMatchObject({ success: true, messageId: secondMessageId });
      expect(
        await instance.admitSubmittedMessage({
          ...request,
          turn: { type: 'prompt', id: firstMessageId, prompt: 'changed replay' },
        })
      ).toMatchObject({ success: false, code: 'BAD_REQUEST' });
      await instance.updateMetadata(originalMetadata);
      expect((await instance.getMetadata())?.initialMessage).toEqual({ id: firstMessageId });
      await expect(
        instance.updateMetadata({
          ...originalMetadata,
          clone: { cloneFromKiloSessionId, reportingCreatedAt: '2099-01-01T00:00:00.000Z' },
        })
      ).rejects.toThrow('Clone reporting creation time cannot be changed');
      expect((await instance.getMetadata())?.clone?.reportingCreatedAt).toBe(reportingCreatedAt);
      expect(await listPendingSessionMessages(instance.ctx.storage)).toHaveLength(2);
    });
  });

  it('chooses one first ID across concurrent first sends', async () => {
    const input = cloneRegistrationInput(new Date().toISOString());
    await runInDurableObject(cloneStub(input), async instance => {
      expect(await instance.registerSession(input)).toEqual({ success: true });
      const firstIdWrites: Array<string | undefined> = [];
      const put = instance.ctx.storage.put.bind(instance.ctx.storage);
      instance.ctx.storage.put = async (key, value) => {
        if (key === 'metadata') {
          firstIdWrites.push(parseSessionMetadata(value).initialMessage?.id);
        }
        return put(key, value);
      };
      try {
        const results = await Promise.all(
          [firstMessageId, secondMessageId].map(messageId =>
            instance.admitSubmittedMessage(
              queueUserMessageInput({
                userId: input.identity.userId,
                messageId,
                prompt: 'concurrent clone send',
              })
            )
          )
        );
        expect(results.every(result => result.success)).toBe(true);
        const initialMessage = (await instance.getMetadata())?.initialMessage;
        expect([firstMessageId, secondMessageId]).toContain(initialMessage?.id);
        expect(firstIdWrites).toEqual([initialMessage?.id]);
        expect(await listPendingSessionMessages(instance.ctx.storage)).toHaveLength(2);
        for (const messageId of [firstMessageId, secondMessageId]) {
          expect(await getSessionMessageState(instance.ctx.storage, messageId)).toMatchObject({
            status: 'queued',
          });
        }
      } finally {
        instance.ctx.storage.put = put;
      }
    });
  });

  it.each(['session_message:', 'metadata'])(
    'rolls back all queued admission writes when writing %s fails',
    async failingKey => {
      const input = cloneRegistrationInput(new Date().toISOString());
      await runInDurableObject(cloneStub(input), async instance => {
        expect(await instance.registerSession(input)).toEqual({ success: true });
        const put = instance.ctx.storage.put.bind(instance.ctx.storage);
        instance.ctx.storage.put = async (key, value) => {
          await put(key, value);
          if (typeof key === 'string' && key.startsWith(failingKey)) {
            throw new Error('queued admission write failed');
          }
        };
        try {
          expect(
            await instance.admitSubmittedMessage(
              queueUserMessageInput({
                userId: input.identity.userId,
                messageId: firstMessageId,
                prompt: 'failed first attempt',
              })
            )
          ).toMatchObject({ success: false, code: 'INTERNAL' });
        } finally {
          instance.ctx.storage.put = put;
        }
        expect(await listPendingSessionMessages(instance.ctx.storage)).toEqual([]);
        expect(await getSessionMessageState(instance.ctx.storage, firstMessageId)).toBeUndefined();
        expect((await instance.getMetadata())?.initialMessage).toBeUndefined();
        expect(
          instance['eventQueries'].findByFilters({ eventTypes: ['cloud.message.queued'] })
        ).toEqual([]);
        expect(
          await instance.admitSubmittedMessage(
            queueUserMessageInput({
              userId: input.identity.userId,
              messageId: secondMessageId,
              prompt: 'successful first admission',
            })
          )
        ).toMatchObject({ success: true });
        expect((await instance.getMetadata())?.initialMessage).toEqual({ id: secondMessageId });
      });
    }
  );

  it('does not enroll old clones on first send or metadata update', async () => {
    const input = cloneRegistrationInput();
    await runInDurableObject(cloneStub(input), async instance => {
      expect(await instance.registerSession(input)).toEqual({ success: true });
      expect(
        await instance.admitSubmittedMessage(
          queueUserMessageInput({
            userId: input.identity.userId,
            messageId: firstMessageId,
            prompt: 'old clone send',
          })
        )
      ).toMatchObject({ success: true });
      const metadata = await instance.getMetadata();
      expect(metadata?.initialMessage).toBeUndefined();
      expect(metadata?.clone).toEqual({ cloneFromKiloSessionId });
      await expect(
        instance.updateMetadata({
          ...metadata,
          clone: { cloneFromKiloSessionId, reportingCreatedAt: new Date().toISOString() },
        })
      ).rejects.toThrow('Clone reporting creation time cannot be changed');
    });
  });

  it.each([false, true])(
    'does not block admission or drain on background anchor writes (first write fails: %s)',
    async failFirstWrite => {
      const input = cloneRegistrationInput(new Date().toISOString());
      const release = Promise.withResolvers<void>();
      let shouldFail = failFirstWrite;
      vi.mocked(sessionReports.ensureCloneSessionReport).mockImplementation(async () => {
        await release.promise;
        if (shouldFail) {
          shouldFail = false;
          throw new Error('PostgreSQL unavailable');
        }
      });
      await runInDurableObject(cloneStub(input), async instance => {
        const reports: CloudAgentQueueReport[] = [];
        const delivered: string[] = [];
        instance['sendRunStateReport'] = async report => {
          reports.push(report);
        };
        instance['executeDirectly'] = async plan => {
          delivered.push(plan.turn.messageId);
          return {
            success: true,
            outcome: 'accepted',
            messageId: plan.turn.messageId,
            wrapperRunId: 'wr_clone_anchor',
          };
        };
        expect(await instance.registerSession(input)).toEqual({ success: true });
        const progress = (async () => {
          expect(
            await instance.admitSubmittedMessage(
              queueUserMessageInput({
                userId: input.identity.userId,
                messageId: firstMessageId,
                prompt: 'drain without reporting',
              })
            )
          ).toMatchObject({ success: true });
          expect(await instance['getSessionMessageQueue']().drainNextPendingMessage()).toEqual({
            remainingPendingCount: 0,
          });
        })();
        try {
          await vi.waitFor(() => expect(delivered).toEqual([firstMessageId]));
          await progress;
          expect(reports).toEqual([]);
          expect(await listPendingSessionMessages(instance.ctx.storage)).toEqual([]);
          expect(sessionReports.ensureCloneSessionReport).toHaveBeenCalledWith(
            expect.objectContaining({
              auth: expect.objectContaining({ kiloSessionId: destinationKiloSessionId }),
              clone: input.clone,
              initialMessage: { id: firstMessageId },
            }),
            expect.anything()
          );
          release.resolve();
          await vi.waitFor(() => expect(reports).toHaveLength(2));
          const state = await getSessionMessageState(instance.ctx.storage, firstMessageId);
          if (!state) throw new Error('Expected persisted first message');
          await instance['reportRunState'](state);
          expect(reports).toHaveLength(3);
          expect(sessionReports.ensureCloneSessionReport).toHaveBeenCalledTimes(3);
        } finally {
          release.resolve();
          await progress;
        }
      });
    }
  );

  it.each(['missing', 'deletion-pending'] as const)(
    'does not anchor from cached identity when live metadata is %s',
    async missingState => {
      const input = cloneRegistrationInput(new Date().toISOString());
      await runInDurableObject(cloneStub(input), async instance => {
        expect(await instance.registerSession(input)).toEqual({ success: true });
        expect(
          await instance.admitSubmittedMessage(
            queueUserMessageInput({
              userId: input.identity.userId,
              messageId: firstMessageId,
              prompt: 'before deletion',
            })
          )
        ).toMatchObject({ success: true });
        const state = await getSessionMessageState(instance.ctx.storage, firstMessageId);
        if (!state) throw new Error('Expected persisted first message');
        if (missingState === 'missing') {
          await instance.ctx.storage.delete('metadata');
        } else {
          await instance.ctx.storage.put('session_deletion_intent', {
            reason: 'explicit',
            requestedAt: Date.now(),
          });
        }
        await instance['reportRunState'](state);
        expect(sessionReports.ensureCloneSessionReport).toHaveBeenLastCalledWith(
          null,
          expect.anything()
        );
        expect(await instance.getMetadata()).toBeNull();
      });
    }
  );
});
