import { describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { AssistantAnswer } from '../../callbacks/assistant-answer.js';
import type { SessionMessage } from './messages.js';
import { CALLBACK_QUEUE_MAX_SERIALIZED_BYTES } from '../../callbacks/queue-payload.js';
import {
  CALLBACK_OUTBOX_PREFIX,
  createMessageCallbacks,
  parseCallbackOutboxValue,
  type PendingCallbackJob,
} from './callbacks.js';

const metadata = {
  metadataSchemaVersion: 2,
  identity: { sessionId: 'workspace_activity', userId: 'user' },
  auth: { kiloSessionId: 'ses_root' },
  lifecycle: { version: 1, timestamp: 1 },
  callback: { target: { url: 'https://example.com/callback' } },
} satisfies SessionMetadata;

describe('control-plane callback recent activity', () => {
  it.each(['workspace:new-chat', 'workspace:workspace_22345678-1234-4234-8234-123456789abc'])(
    'retains the parent message identity through durable outbox repair and retries for %s',
    async url => {
      const stored = new Map<string, PendingCallbackJob>();
      const sent: PendingCallbackJob['job'][] = [];
      const dependencies = {
        storage: {
          kv: {
            get: <T>(key: string) => stored.get(key) as T | undefined,
            put: (key: string, value: PendingCallbackJob) => stored.set(key, value),
            delete: (key: string) => stored.delete(key),
            list: () => stored,
          } as DurableObjectStorage['kv'],
        },
        getMetadata: () => ({ ...metadata, callback: { target: { url } } }),
        getCallbackQueue: () => ({
          send: async (job: PendingCallbackJob['job']) => {
            sent.push(structuredClone(job));
            if (sent.length === 1) throw new Error('Ambiguous queue send');
            return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
          },
        }),
        getAssistantAnswerForUserMessage: () => null,
        getRecentAssistantAnswersForUserMessage: () => [],
      };
      const message = {
        messageId: 'original_user',
        intent: { agent: {} },
        state: 'completed',
        createdAt: 1,
        acceptedAt: 2,
        settledAt: 3,
        reason: null,
      } as SessionMessage;
      const callbacks = createMessageCallbacks(dependencies);
      expect(callbacks.persistDrainedBatchCallback([message], new Set([message.messageId]))).toBe(
        true
      );
      const key = `${CALLBACK_OUTBOX_PREFIX}${message.messageId}`;
      const pending = stored.get(key);
      expect(pending?.job.parentSession).toEqual({
        userId: metadata.identity.userId,
        messageId: expect.stringMatching(/^msg_/),
      });
      expect(parseCallbackOutboxValue(pending)).toEqual(pending);
      expect(
        parseCallbackOutboxValue({ ...pending, job: { ...pending?.job, parentSession: undefined } })
      ).toBeUndefined();
      await callbacks.repair();
      expect(stored.size).toBe(1);
      await createMessageCallbacks(dependencies).repair(Date.now() + 60_000);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
      expect(stored.size).toBe(0);
    }
  );
  it.each([
    { state: 'completed', finalText: '' },
    { state: 'completed', finalText: 'Complete answer' },
    { state: 'completed', finalText: 'x'.repeat(CALLBACK_QUEUE_MAX_SERIALIZED_BYTES) },
    { state: 'failed', finalText: '' },
    { state: 'cancelled', finalText: '' },
  ] satisfies { state: SessionMessage['state']; finalText: string }[])(
    'snapshots completed activity without changing final text: $state ($finalText.length chars)',
    ({ state, finalText }) => {
      const stored = new Map<string, PendingCallbackJob>();
      const recentMessages: AssistantAnswer[] = [
        { text: 'Checking the build', tools: [{ name: 'bash', status: 'completed' }] },
        { text: finalText, tools: [] },
      ];
      const getRecentAssistantAnswersForUserMessage = vi.fn(() => recentMessages);
      const callbacks = createMessageCallbacks({
        storage: {
          kv: {
            get: <T>(key: string) => stored.get(key) as T | undefined,
            put: (key: string, value: PendingCallbackJob) => {
              stored.set(key, value);
            },
            delete: (key: string) => stored.delete(key),
            list: () => stored,
          } as DurableObjectStorage['kv'],
        },
        getMetadata: () => metadata,
        getCallbackQueue: () => undefined,
        getAssistantAnswerForUserMessage: () => recentMessages[1],
        getRecentAssistantAnswersForUserMessage,
      });
      const message = {
        messageId: 'original_user',
        intent: { agent: {} },
        state,
        createdAt: 1,
        acceptedAt: 2,
        settledAt: 3,
        reason: null,
      } as SessionMessage;
      expect(callbacks.persistDrainedBatchCallback([message], new Set([message.messageId]))).toBe(
        true
      );
      const payload = stored.get(`${CALLBACK_OUTBOX_PREFIX}${message.messageId}`)?.job.payload;
      expect(payload?.lastAssistantMessageText).toBe(
        finalText && finalText.length < CALLBACK_QUEUE_MAX_SERIALIZED_BYTES ? finalText : undefined
      );
      if (state === 'completed') {
        expect(getRecentAssistantAnswersForUserMessage).toHaveBeenCalledWith(
          'workspace_activity',
          'ses_root',
          'original_user'
        );
        const activity = JSON.parse(payload?.recentActivity ?? 'null');
        expect(activity.partial).toBe(true);
        expect(activity.messages[0]).toEqual({
          text: 'Checking the build',
          tools: [{ name: 'bash', status: 'completed' }],
        });
        expect(activity.messages).toHaveLength(finalText ? 2 : 1);
      } else {
        expect(getRecentAssistantAnswersForUserMessage).not.toHaveBeenCalled();
        expect(payload?.recentActivity).toBeUndefined();
      }
    }
  );
});
