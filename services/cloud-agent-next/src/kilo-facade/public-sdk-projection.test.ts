import { describe, expect, it } from 'vitest';
import { projectPrivateWorktreePaths } from '@kilocode/session-ingest-contracts';

import { projectPublicStoredMessage } from './public-sdk-projection';

const kiloSessionId = 'ses_12345678901234567890123456';

describe('projectPrivateWorktreePaths', () => {
  const privateDirectory =
    '/workspace/private/worktrees/worktree_12345678-1234-4234-8234-123456789abc';
  const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;
  const value = {
    text: `Read ${privateDirectory}/file.txt`,
    nested: [null, 1, true, { output: `Created ${privateDirectory}/other.txt` }],
    relative: 'src/file.txt',
  };

  it.each([
    { directory: privateDirectory },
    { role: 'assistant', path: { cwd: privateDirectory, root: privateDirectory } },
  ])('projects validated metadata directories recursively without mutating input: %j', info => {
    const original = structuredClone(value);
    const projected = projectPrivateWorktreePaths(value, [info], publicDirectory);

    expect(projected).toEqual({
      text: `Read ${publicDirectory}/file.txt`,
      nested: [null, 1, true, { output: `Created ${publicDirectory}/other.txt` }],
      relative: 'src/file.txt',
    });
    expect(value).toEqual(original);
  });

  it.each([
    null,
    { directory: '/' },
    { directory: '/legacy/checkout' },
    { directory: `${privateDirectory}/file.txt` },
    { directory: `User mentioned ${privateDirectory}` },
    { role: 'user', path: { cwd: privateDirectory } },
    { role: 'assistant', text: privateDirectory },
    { role: 'assistant', path: privateDirectory },
  ])('does not infer a checkout from invalid metadata or free text: %j', info => {
    expect(projectPrivateWorktreePaths(value, [info], publicDirectory)).toEqual(value);
  });
});

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
                outputs: [
                  `${privateDirectory}/nested.txt`,
                  { output: `Created ${privateDirectory}/other.txt`, relative: 'src/relative.ts' },
                ],
              },
              time: { start: 100, end: 101 },
            },
          },
          {
            id: 'prt_grouped_text',
            sessionID: kiloSessionId,
            messageID: 'msg_grouped',
            type: 'text',
            text: `Updated ${privateDirectory}/shared.txt and src/relative.ts`,
          },
        ],
      },
      kiloSessionId
    );

    expect(projected.info).toMatchObject({ path: { cwd: publicDirectory, root: publicDirectory } });
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
            outputs: [
              `${publicDirectory}/nested.txt`,
              { output: `Created ${publicDirectory}/other.txt`, relative: 'src/relative.ts' },
            ],
          },
        },
      },
      { text: `Updated ${publicDirectory}/shared.txt and src/relative.ts` },
    ]);
  });

  it('does not discover private prefixes from free text in legacy or user messages', () => {
    const mentionedDirectory =
      '/workspace/private/worktrees/worktree_12345678-1234-4234-8234-123456789abc';
    const text = `Keep ${mentionedDirectory}/example.txt and src/relative.ts as written`;
    const projected = projectPublicStoredMessage(
      {
        info: {
          id: 'msg_legacy',
          sessionID: kiloSessionId,
          role: 'assistant',
          time: { created: 100 },
          parentID: 'msg_user',
          modelID: 'fake',
          providerID: 'kilo',
          mode: 'code',
          agent: 'code',
          path: { cwd: '/legacy/checkout', root: '/legacy/checkout' },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts: [
          {
            id: 'prt_legacy_text',
            sessionID: kiloSessionId,
            messageID: 'msg_legacy',
            type: 'text',
            text,
          },
        ],
      },
      kiloSessionId
    );

    expect(projected.parts).toMatchObject([{ text }]);
    const userMessage = projectPublicStoredMessage(
      {
        info: {
          id: 'msg_user',
          sessionID: kiloSessionId,
          role: 'user',
          time: { created: 100 },
          agent: 'code',
          model: { providerID: 'kilo', modelID: 'fake' },
        },
        parts: [{ ...projected.parts[0], messageID: 'msg_user' }],
      },
      kiloSessionId
    );
    expect(userMessage.parts).toMatchObject([{ text }]);
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
