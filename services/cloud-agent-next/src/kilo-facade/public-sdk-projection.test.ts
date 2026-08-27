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

  it('rewrites grouped private checkout paths in tool outputs and nested metadata', () => {
    const privateDirectory =
      '/workspace/private/worktrees/worktree_12345678-1234-4234-8234-123456789abc';
    const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;
    const projected = projectPublicStoredMessage(
      {
        info: {
          id: 'msg_grouped',
          sessionID: kiloSessionId,
          role: 'assistant',
          time: { created: 100, completed: 101 },
          parentID: 'msg_user',
          modelID: 'fake',
          providerID: 'kilo',
          mode: 'code',
          agent: 'code',
          path: { cwd: privateDirectory, root: privateDirectory },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: 'prt_grouped_tool',
            sessionID: kiloSessionId,
            messageID: 'msg_grouped',
            type: 'tool',
            callID: 'call_grouped',
            tool: 'edit',
            state: {
              status: 'completed',
              input: { filePath: `${privateDirectory}/shared.txt`, unrelated: '/owner/project' },
              output: `Read ${privateDirectory}/shared.txt without losing file contents`,
              title: 'edit',
              metadata: {
                filepath: `${privateDirectory}/shared.txt`,
                display: { path: `${privateDirectory}/shared.txt` },
                filediff: {
                  file: `${privateDirectory}/shared.txt`,
                  patch: `--- ${privateDirectory}/shared.txt\n+file contents`,
                },
              },
              time: { start: 100, end: 101 },
            },
          },
        ],
      },
      kiloSessionId
    );

    expect(JSON.stringify(projected)).not.toContain(privateDirectory);
    expect(projected.parts).toMatchObject([
      {
        state: {
          input: { filePath: `${publicDirectory}/shared.txt`, unrelated: '/owner/project' },
          output: `Read ${publicDirectory}/shared.txt without losing file contents`,
          metadata: {
            filepath: `${publicDirectory}/shared.txt`,
            display: { path: `${publicDirectory}/shared.txt` },
            filediff: {
              file: `${publicDirectory}/shared.txt`,
              patch: `--- ${publicDirectory}/shared.txt\n+file contents`,
            },
          },
        },
      },
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
