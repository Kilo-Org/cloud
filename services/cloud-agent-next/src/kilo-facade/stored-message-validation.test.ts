import { describe, expect, it } from 'vitest';

import {
  parseOwnedKiloSdkStoredMessage,
  parseOwnedKiloSdkStoredMessages,
} from './stored-message-validation.js';

const kiloSessionId = 'ses_12345678901234567890123456';
const messageId = 'msg_valid_01';
const message = {
  info: {
    id: messageId,
    sessionID: kiloSessionId,
    role: 'user' as const,
    time: { created: 100 },
    agent: 'build',
    model: { providerID: 'provider', modelID: 'model' },
  },
  parts: [
    {
      id: 'prt_valid_01',
      sessionID: kiloSessionId,
      messageID: messageId,
      type: 'text' as const,
      text: 'hello',
    },
  ],
};

describe('stored message validation', () => {
  it('validates the shared stored-message schema and selected identities', () => {
    expect(parseOwnedKiloSdkStoredMessage(message, kiloSessionId, messageId)).toEqual(message);
    expect(
      parseOwnedKiloSdkStoredMessage(
        {
          ...message,
          parts: [{ ...message.parts[0], sessionID: 'ses_abcdefghijklmnopqrstuvwxyz' }],
        },
        kiloSessionId,
        messageId
      )
    ).toBeNull();
    expect(
      parseOwnedKiloSdkStoredMessage(
        { ...message, parts: [{ ...message.parts[0], messageID: 'msg_other_02' }] },
        kiloSessionId,
        messageId
      )
    ).toBeNull();
  });

  it('rejects nested tool attachments belonging to another message', () => {
    expect(
      parseOwnedKiloSdkStoredMessage(
        {
          ...message,
          parts: [
            {
              id: 'prt_tool_01',
              sessionID: kiloSessionId,
              messageID: messageId,
              type: 'tool',
              callID: 'call_01',
              tool: 'read',
              state: {
                status: 'completed',
                input: {},
                output: 'done',
                title: 'Read',
                metadata: {},
                time: { start: 1, end: 2 },
                attachments: [
                  {
                    id: 'prt_attachment_01',
                    sessionID: kiloSessionId,
                    messageID: 'msg_other_02',
                    type: 'file',
                    mime: 'text/plain',
                    url: 'file:///tmp/value.txt',
                  },
                ],
              },
            },
          ],
        },
        kiloSessionId,
        messageId
      )
    ).toBeNull();
  });

  it('returns null instead of throwing for malformed discriminated parts', () => {
    expect(
      parseOwnedKiloSdkStoredMessages(
        [
          message,
          {
            ...message,
            parts: [{ ...message.parts[0], type: 'tool', state: { status: 'unknown' } }],
          },
        ],
        kiloSessionId
      )
    ).toBeNull();
  });
});
