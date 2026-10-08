import { describe, expect, it, vi } from 'vitest';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import type { LatestAssistantMessage } from '../../session/types.js';
import type { SessionMessage } from './messages.js';
import { CALLBACK_QUEUE_MAX_SERIALIZED_BYTES } from '../../callbacks/queue-payload.js';
import {
  CALLBACK_OUTBOX_PREFIX,
  createMessageCallbacks,
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
      const recentMessages: LatestAssistantMessage[] = [
        {
          eventId: 1 as LatestAssistantMessage['eventId'],
          timestamp: 1,
          info: { id: 'earlier', role: 'assistant' },
          parts: [
            { id: 'text', messageID: 'earlier', type: 'text', text: 'Checking the build' },
            {
              id: 'tool',
              messageID: 'earlier',
              type: 'tool',
              tool: 'bash',
              state: { status: 'completed', input: 'private', output: 'private' },
            },
          ],
        },
        {
          eventId: 2 as LatestAssistantMessage['eventId'],
          timestamp: 2,
          info: { id: 'latest', role: 'assistant' },
          parts: finalText
            ? [{ id: 'final', messageID: 'latest', type: 'text', text: finalText }]
            : [],
        },
      ];
      const getRecentAssistantMessagesForUserMessage = vi.fn(() => recentMessages);
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
        getAssistantMessageForUserMessage: () => recentMessages[1],
        getRecentAssistantMessagesForUserMessage,
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
        expect(getRecentAssistantMessagesForUserMessage).toHaveBeenCalledWith(
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
        expect(getRecentAssistantMessagesForUserMessage).not.toHaveBeenCalled();
        expect(payload?.recentActivity).toBeUndefined();
      }
    }
  );
});
