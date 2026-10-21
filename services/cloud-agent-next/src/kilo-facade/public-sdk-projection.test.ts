import { describe, expect, it } from 'vitest';
import { projectPrivateWorktreePaths } from '@kilocode/session-ingest-contracts';
import type { KiloSdkStoredMessage } from '../session-ingest-binding.js';

import {
  projectPublicMessageInfo,
  projectPublicPart,
  projectPublicStoredMessage,
  projectPublicStructuredPaths,
} from './public-sdk-projection';

const kiloSessionId = 'ses_12345678901234567890123456';

describe('projectPublicStructuredPaths', () => {
  it('redacts only structured local file URI fields without touching text, external URLs or data URLs', () => {
    const value = {
      uri: 'file:///workspace/private/resource.txt',
      metadata: {
        url: 'FILE:///workspace/private/attachment.txt',
        resources: [{ uri: 'file://localhost/workspace/private/resource.txt' }],
        external: { uri: 'https://example.com/resource', url: 'http://example.com/attachment' },
        embedded: { uri: 'data:text/plain,safe', url: 'data:text/plain,safe' },
      },
      text: 'Keep file:///workspace/private/resource.txt',
      output: 'Read file:///workspace/private/attachment.txt',
      input: { content: 'User file:///workspace/private/resource.txt' },
    };
    const original = structuredClone(value);
    expect(projectPublicStructuredPaths(value, kiloSessionId)).toEqual({
      ...value,
      uri: '',
      metadata: {
        ...value.metadata,
        url: '',
        resources: [{ uri: '' }],
      },
    });
    expect(value).toEqual(original);
  });
  it('projects structured diff objects inside SDK files arrays', () => {
    const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;
    expect(
      projectPublicStructuredPaths(
        {
          files: [
            {
              path: '/workspace/app/a.ts',
              status: 'modified',
              patch:
                '--- /workspace/app/a.ts\n+++ /workspace/app/a.ts\n@@ -1 +1 @@\n+Keep /workspace/app/user-text',
            },
          ],
        },
        kiloSessionId
      )
    ).toEqual({
      files: [
        {
          path: publicDirectory,
          status: 'modified',
          patch: `--- ${publicDirectory}\n+++ ${publicDirectory}\n@@ -1 +1 @@\n+Keep /workspace/app/user-text`,
        },
      ],
    });
  });
  it('preserves CRLF diff headers and hunk contents', () => {
    const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;
    expect(
      projectPublicStructuredPaths(
        {
          patch:
            '--- /workspace/app/a.ts\t2026-10-19\r\n+++ /workspace/app/a.ts\r\n@@ -1 +1 @@\r\n+/workspace/app/user-text\r\n',
        },
        kiloSessionId
      )
    ).toEqual({
      patch: `--- ${publicDirectory}\t2026-10-19\r\n+++ ${publicDirectory}\r\n@@ -1 +1 @@\r\n+/workspace/app/user-text\r\n`,
    });
  });
  it.each([
    '/workspace/app',
    '/workspace/private/worktrees/worktree_12345678-1234-4234-8234-123456789abc',
  ])(
    'projects structured paths from the actual root %s without masking arbitrary text',
    privateDirectory => {
      const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;
      const text = `Read ${privateDirectory}/file.txt`;
      const value = {
        info: { role: 'assistant', path: { cwd: privateDirectory, root: privateDirectory } },
        nested: {
          filepath: `${privateDirectory}/file.txt`,
          filePath: `${privateDirectory}/nested.txt`,
          file: 'relative.ts',
          files: [`${privateDirectory}/file.txt`, 'src/a.ts'],
          text,
          output: text,
          title: text,
        },
        input: { content: text },
        directory: privateDirectory,
      };
      const original = structuredClone(value);
      expect(projectPublicStructuredPaths(value, kiloSessionId)).toEqual({
        ...value,
        info: { role: 'assistant', path: { cwd: publicDirectory, root: publicDirectory } },
        nested: {
          ...value.nested,
          filepath: `${publicDirectory}/file.txt`,
          filePath: `${publicDirectory}/nested.txt`,
          files: [`${publicDirectory}/file.txt`, 'src/a.ts'],
        },
        directory: publicDirectory,
      });
      expect(value).toEqual(original);
    }
  );

  it('normalizes git headers, timestamps, quotes, renames and multiple files without modifying hunk contents', () => {
    const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;
    const patch = [
      'diff --git a//workspace/app/a.ts b//workspace/app/a.ts',
      '--- /dev/null',
      '+++ /workspace/app/a.ts\t2026-10-19',
      '@@ -0,0 +1,2 @@',
      '+Keep /workspace/app/a.ts',
      '+++ /workspace/app/this-is-added-content.ts',
      'diff --git "a//workspace/app/file name.ts" "b//workspace/app/new name.ts"',
      'rename from /workspace/app/file name.ts',
      'rename to /workspace/app/new name.ts',
      '--- "a//workspace/app/file name.ts"',
      '+++ "b//workspace/app/new name.ts"',
      '@@ -1 +1 @@',
      '-old /workspace/app/file name.ts',
      '+new /workspace/app/new name.ts',
      '',
    ].join('\n');
    const expected = [
      `diff --git a/${publicDirectory}/a.ts b/${publicDirectory}/a.ts`,
      '--- /dev/null',
      `+++ ${publicDirectory}/a.ts\t2026-10-19`,
      '@@ -0,0 +1,2 @@',
      '+Keep /workspace/app/a.ts',
      '+++ /workspace/app/this-is-added-content.ts',
      `diff --git "a/${publicDirectory}/file name.ts" "b/${publicDirectory}/new name.ts"`,
      `rename from ${publicDirectory}/file name.ts`,
      `rename to ${publicDirectory}/new name.ts`,
      `--- "a/${publicDirectory}/file name.ts"`,
      `+++ "b/${publicDirectory}/new name.ts"`,
      '@@ -1 +1 @@',
      '-old /workspace/app/file name.ts',
      '+new /workspace/app/new name.ts',
      '',
    ].join('\n');
    expect(
      projectPublicStructuredPaths(
        { directory: '/workspace/app', metadata: { diff: patch, filediff: { patch } } },
        kiloSessionId
      )
    ).toEqual({
      directory: publicDirectory,
      metadata: { diff: expected, filediff: { patch: expected } },
    });
  });

  it('normalizes unknown absolute structured paths but preserves relative paths, public paths and user text', () => {
    const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;
    const value = {
      filepath: '/workspace/app/a.ts',
      file: 'C:\\private\\a.ts',
      root: '\\\\private\\share',
      files: ['src/a.ts', '/private/a.ts', `${publicDirectory}/a.ts`],
      metadata: {
        patch: '--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-/private/a.ts\n+/private/b.ts',
      },
      text: '/workspace/app/a.ts',
    };
    expect(projectPublicStructuredPaths(value, kiloSessionId)).toEqual({
      ...value,
      filepath: publicDirectory,
      file: publicDirectory,
      root: publicDirectory,
      files: ['src/a.ts', publicDirectory, `${publicDirectory}/a.ts`],
    });
  });
});

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
  it('retains already-public typed file and patch path suffixes', () => {
    const file = `/cloud-agent/sessions/${kiloSessionId}/native-permission.txt`;
    expect(
      projectPublicPart(
        {
          id: 'prt_patch',
          sessionID: kiloSessionId,
          messageID: 'msg_patch',
          type: 'patch',
          hash: 'hash',
          files: [file],
        },
        kiloSessionId
      )
    ).toMatchObject({ files: [file] });
    expect(
      projectPublicPart(
        {
          id: 'prt_file',
          sessionID: kiloSessionId,
          messageID: 'msg_file',
          type: 'file',
          mime: 'text/plain',
          url: 'data:text/plain,safe',
          source: { type: 'file', path: file, text: { value: 'file', start: 0, end: 4 } },
        },
        kiloSessionId
      )
    ).toMatchObject({ source: { path: file } });
  });
  it.each(['/workspace/app', `/cloud-agent/sessions/${kiloSessionId}`])(
    'projects captured stored write metadata when assistant cwd is %s',
    cwd => {
      const publicDirectory = `/cloud-agent/sessions/${kiloSessionId}`;
      const content =
        'permission-e2e\n\n<system-reminder>\nKeep /workspace/app/native-permission.txt as user content\n</system-reminder>';
      const patch = `Index: /workspace/app/native-permission.txt\n===================================================================\n--- /workspace/app/native-permission.txt\n+++ /workspace/app/native-permission.txt\n@@ -0,0 +1,5 @@\n+${content.replaceAll('\n', '\n+')}\n\\ No newline at end of file\n`;
      const message = {
        info: {
          id: 'msg_captured_write',
          sessionID: kiloSessionId,
          role: 'assistant',
          time: { created: 100, completed: 101 },
          parentID: 'msg_user',
          modelID: 'fake-deterministic',
          providerID: 'kilo',
          mode: 'native-probe',
          agent: 'native-probe',
          path: { cwd, root: cwd },
          cost: 0,
          tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: 'tool-calls',
        },
        parts: [
          {
            id: 'prt_captured_write',
            sessionID: kiloSessionId,
            messageID: 'msg_captured_write',
            type: 'tool',
            callID: 'call_write',
            tool: 'write',
            state: {
              status: 'completed',
              input: { filePath: 'native-permission.txt', content },
              output: 'Wrote file successfully.',
              title: 'native-permission.txt',
              metadata: {
                diagnostics: {},
                filepath: '/workspace/app/native-permission.txt',
                exists: false,
                diff: patch,
                filediff: {
                  file: '/workspace/app/native-permission.txt',
                  patch,
                  additions: 5,
                  deletions: 0,
                },
                truncated: false,
                approval: { source: 'manual' },
              },
              time: { start: 100, end: 101 },
            },
          },
        ],
      } satisfies KiloSdkStoredMessage;
      const original = structuredClone(message);
      const publicFile =
        cwd === '/workspace/app' ? `${publicDirectory}/native-permission.txt` : publicDirectory;
      const publicPatch = patch
        .replaceAll('Index: /workspace/app/native-permission.txt', `Index: ${publicFile}`)
        .replaceAll('--- /workspace/app/native-permission.txt', `--- ${publicFile}`)
        .replaceAll('+++ /workspace/app/native-permission.txt', `+++ ${publicFile}`);
      expect(projectPublicStoredMessage(message, kiloSessionId)).toEqual({
        info: { ...message.info, path: { cwd: publicDirectory, root: publicDirectory } },
        parts: [
          {
            ...message.parts[0],
            state: {
              ...message.parts[0].state,
              metadata: {
                ...message.parts[0].state.metadata,
                filepath: publicFile,
                diff: publicPatch,
                filediff: {
                  ...message.parts[0].state.metadata.filediff,
                  file: publicFile,
                  patch: publicPatch,
                },
              },
            },
          },
        ],
      });
      expect(projectPublicPart(message.parts[0], kiloSessionId)).toMatchObject({
        state: {
          input: { content },
          metadata: {
            filepath: publicDirectory,
            diff: publicPatch.replaceAll(publicFile, publicDirectory),
            filediff: { file: publicDirectory },
          },
        },
      });
      const infoWithMetadata = {
        ...message.info,
        filepath: '/workspace/app/native-permission.txt',
      };
      expect(projectPublicMessageInfo(infoWithMetadata, kiloSessionId)).toMatchObject({
        filepath: publicFile,
      });
      expect(message).toEqual(original);
    }
  );
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

  it('rewrites grouped structured checkout paths while preserving text and tool outputs', () => {
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
    expect(projected.parts).toMatchObject([
      {
        state: {
          input: { filePath: `${publicDirectory}/shared.txt`, unrelated: '/owner/project' },
          output: `Read ${privateDirectory}/shared.txt without losing file contents`,
          metadata: {
            filepath: `${publicDirectory}/shared.txt`,
            display: { path: `${publicDirectory}/shared.txt` },
            filediff: {
              file: `${publicDirectory}/shared.txt`,
              patch: `--- ${publicDirectory}/shared.txt\n+file contents`,
            },
            outputs: [
              `${privateDirectory}/nested.txt`,
              { output: `Created ${privateDirectory}/other.txt`, relative: 'src/relative.ts' },
            ],
          },
        },
      },
      { text: `Updated ${privateDirectory}/shared.txt and src/relative.ts` },
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

  it.each([
    ['file:///workspace/private/resource.txt', ''],
    ['FILE://localhost/workspace/private/resource.txt', ''],
    ['https://example.com/resource.txt', 'https://example.com/resource.txt'],
    ['data:text/plain,safe', 'data:text/plain,safe'],
  ])('projects typed resource URI %s without changing SDK resource fields', (uri, publicUri) => {
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
              uri,
            },
          },
        ],
      },
      kiloSessionId
    );

    expect(projected.parts).toMatchObject([
      {
        url: 'data:text/plain,safe',
        source: {
          type: 'resource',
          text: { value: 'private', start: 0, end: 7 },
          clientName: 'wrapper',
          uri: publicUri,
        },
      },
    ]);
  });
});
