import { describe, expect, it } from 'vitest';

import { projectPublicStoredMessage } from './public-sdk-projection';

const kiloSessionId = 'ses_12345678901234567890123456';

describe('projectPublicStoredMessage', () => {
  it('redacts wrapper-local file URLs from typed stored file parts while preserving data URLs', () => {
    const projected = projectPublicStoredMessage(
      {
        info: {
          id: 'msg_files',
          sessionID: kiloSessionId,
          role: 'user',
          time: { created: 100 },
          agent: 'build',
          model: { providerID: 'test', modelID: 'fake' },
        },
        parts: [
          {
            id: 'prt_local_file',
            sessionID: kiloSessionId,
            messageID: 'msg_files',
            type: 'file',
            mime: 'text/plain',
            url: 'file:///workspace/private/secret.txt',
          },
          {
            id: 'prt_data_file',
            sessionID: kiloSessionId,
            messageID: 'msg_files',
            type: 'file',
            mime: 'text/plain',
            url: 'data:text/plain,safe',
          },
          {
            id: 'prt_tool',
            sessionID: kiloSessionId,
            messageID: 'msg_files',
            type: 'tool',
            callID: 'call_files',
            tool: 'read',
            state: {
              status: 'completed',
              input: {},
              output: 'safe',
              title: 'read',
              metadata: {},
              time: { start: 100, end: 101 },
              attachments: [
                {
                  id: 'prt_local_attachment',
                  sessionID: kiloSessionId,
                  messageID: 'msg_files',
                  type: 'file',
                  mime: 'text/plain',
                  url: 'file:///workspace/private/attachment.txt',
                },
              ],
            },
          },
        ],
      },
      kiloSessionId
    );

    expect(projected.parts).toMatchObject([
      { url: '' },
      { url: 'data:text/plain,safe' },
      { state: { attachments: [{ url: '' }] } },
    ]);
  });

  it('preserves owner-visible typed resource file URIs', () => {
    const projected = projectPublicStoredMessage(
      {
        info: {
          id: 'msg_resource',
          sessionID: kiloSessionId,
          role: 'user',
          time: { created: 100 },
          agent: 'build',
          model: { providerID: 'test', modelID: 'fake' },
        },
        parts: [
          {
            id: 'prt_resource',
            sessionID: kiloSessionId,
            messageID: 'msg_resource',
            type: 'file',
            mime: 'text/plain',
            url: 'data:text/plain,safe',
            source: {
              type: 'resource',
              text: { value: 'private', start: 0, end: 7 },
              clientName: 'wrapper',
              uri: 'file:///workspace/private/resource.txt',
            },
          },
        ],
      },
      kiloSessionId
    );

    expect(projected.parts).toMatchObject([
      { source: { type: 'resource', uri: 'file:///workspace/private/resource.txt' } },
    ]);
  });
});
