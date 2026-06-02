import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CallbackJob } from '../../../src/callbacks/types.js';
import { listPendingSessionMessages } from '../../../src/session/pending-messages.js';
import { getSessionMessageState } from '../../../src/session/session-message-state.js';
import { queueUserMessageInput, registerReadySession } from '../../helpers/session-setup.js';

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
        if (!failedQueuedState && String(key).startsWith('session_message:')) {
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
