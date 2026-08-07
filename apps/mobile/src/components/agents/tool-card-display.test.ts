import { type FilePart, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { getToolDisplay, type ToolDisplay, toolPartHasDetails } from './tool-card-display';

function makeToolPart(tool: string, state: ToolPart['state']): ToolPart {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state,
  };
}

function completed(input: Record<string, unknown> = {}, output = ''): ToolPart['state'] {
  return {
    status: 'completed',
    input,
    output,
    title: '',
    metadata: {},
    time: { start: 0, end: 1 },
  };
}

function running(input: Record<string, unknown> = {}): ToolPart['state'] {
  return { status: 'running', input, time: { start: 0 } };
}

function errorState(input: Record<string, unknown> = {}, error = 'failed'): ToolPart['state'] {
  return { status: 'error', input, error, time: { start: 0, end: 1 } };
}

function makeAttachment(mime: string): FilePart {
  return {
    id: 'att-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime,
    url: '',
  };
}

/** Typed read of the projection — pins the exported `ToolDisplay` shape. */
function getDisplay(part: ToolPart): ToolDisplay {
  return getToolDisplay(part);
}

describe('getToolDisplay mapping', () => {
  it('maps read with and without a file path', () => {
    expect(getDisplay(makeToolPart('read', completed({ filePath: '/repo/src/app.ts' })))).toEqual({
      title: 'read',
      subtitle: 'app.ts',
    });
    expect(getDisplay(makeToolPart('read', completed()))).toEqual({
      title: 'read',
      subtitle: 'read',
    });
  });

  it('maps edit with and without a file path', () => {
    expect(getDisplay(makeToolPart('edit', completed({ filePath: 'src/app.tsx' })))).toEqual({
      title: 'edit',
      subtitle: 'app.tsx',
    });
    expect(getDisplay(makeToolPart('edit', completed()))).toEqual({
      title: 'edit',
      subtitle: 'edit',
    });
  });

  it('maps write with and without a file path', () => {
    expect(getDisplay(makeToolPart('write', completed({ filePath: 'new-file.ts' })))).toEqual({
      title: 'write',
      subtitle: 'new-file.ts',
    });
    expect(getDisplay(makeToolPart('write', completed()))).toEqual({
      title: 'write',
      subtitle: 'write',
    });
  });

  it('maps bash description, command, and empty input', () => {
    expect(getDisplay(makeToolPart('bash', completed({ description: 'List files' })))).toEqual({
      title: 'bash',
      subtitle: 'List files',
    });
    expect(getDisplay(makeToolPart('bash', completed({ command: 'ls -la' })))).toEqual({
      title: 'bash',
      subtitle: 'ls -la',
    });
    expect(getDisplay(makeToolPart('bash', completed()))).toEqual({
      title: 'bash',
      subtitle: 'bash',
    });
  });

  it('truncates a long bash command to 60 characters', () => {
    const command = 'x'.repeat(70);
    expect(getDisplay(makeToolPart('bash', completed({ command }))).subtitle).toBe(
      `${'x'.repeat(60)}\u2026`
    );
  });

  it('maps glob with a pattern', () => {
    expect(getDisplay(makeToolPart('glob', completed({ pattern: '**/*.ts' })))).toEqual({
      title: 'glob',
      subtitle: '**/*.ts',
    });
  });

  it('maps grep with pattern and include', () => {
    expect(
      getDisplay(makeToolPart('grep', completed({ pattern: 'foo', include: '*.ts' })))
    ).toEqual({ title: 'grep', subtitle: 'foo (*.ts)' });
    expect(getDisplay(makeToolPart('grep', completed({ pattern: 'foo' })))).toEqual({
      title: 'grep',
      subtitle: 'foo',
    });
    expect(getDisplay(makeToolPart('grep', completed()))).toEqual({
      title: 'grep',
      subtitle: 'grep',
    });
  });

  it('maps list from path or filePath', () => {
    expect(getDisplay(makeToolPart('list', completed({ path: '/repo/src' })))).toEqual({
      title: 'list',
      subtitle: 'src',
    });
    expect(getDisplay(makeToolPart('list', completed({ filePath: '/repo/src' })))).toEqual({
      title: 'list',
      subtitle: 'src',
    });
    expect(getDisplay(makeToolPart('list', completed()))).toEqual({
      title: 'list',
      subtitle: 'list',
    });
  });

  it('maps websearch, codesearch, and webfetch from query or url', () => {
    expect(getDisplay(makeToolPart('websearch', completed({ query: 'search terms' })))).toEqual({
      title: 'websearch',
      subtitle: 'search terms',
    });
    expect(
      getDisplay(makeToolPart('websearch', completed({ url: 'https://example.com' })))
    ).toEqual({ title: 'websearch', subtitle: 'https://example.com' });
    expect(
      getDisplay(makeToolPart('websearch', completed({ query: '', url: 'https://example.com' })))
    ).toEqual({ title: 'websearch', subtitle: 'https://example.com' });
    expect(getDisplay(makeToolPart('websearch', completed()))).toEqual({
      title: 'websearch',
      subtitle: 'websearch',
    });
    expect(getDisplay(makeToolPart('codesearch', completed({ query: 'foo' })))).toEqual({
      title: 'codesearch',
      subtitle: 'foo',
    });
    expect(getDisplay(makeToolPart('webfetch', completed({ url: 'https://example.com' })))).toEqual(
      { title: 'webfetch', subtitle: 'https://example.com' }
    );
  });

  it('maps todo read and todo write', () => {
    expect(getDisplay(makeToolPart('todoread', completed()))).toEqual({
      title: 'todoread',
      subtitle: 'Read todos',
    });
    expect(getDisplay(makeToolPart('todowrite', completed()))).toEqual({
      title: 'todowrite',
      subtitle: 'Update todos',
    });
  });

  it('maps task from description or prompt', () => {
    expect(getDisplay(makeToolPart('task', completed({ description: 'Do the thing' })))).toEqual({
      title: 'task',
      subtitle: 'Do the thing',
    });
    expect(getDisplay(makeToolPart('task', completed({ prompt: 'short' })))).toEqual({
      title: 'task',
      subtitle: 'short',
    });
    expect(getDisplay(makeToolPart('task', completed()))).toEqual({
      title: 'task',
      subtitle: 'task',
    });
  });

  it('maps suggest completed and error labels', () => {
    expect(getDisplay(makeToolPart('suggest', completed()))).toEqual({
      title: 'Suggestion',
      subtitle: 'Suggestion',
    });
    expect(getDisplay(makeToolPart('suggest', errorState()))).toEqual({
      title: 'Suggestion',
      subtitle: 'Suggestion dismissed',
    });
  });

  it('maps an MCP tool to server/tool title', () => {
    expect(
      getDisplay(
        makeToolPart('mcp', completed({ server_name: 'filesystem', tool_name: 'read_file' }))
      )
    ).toEqual({ title: 'mcp', subtitle: 'filesystem/read_file' });
  });

  it('falls back to the tool name for unknown tools', () => {
    expect(getDisplay(makeToolPart('unknown-tool', completed()))).toEqual({
      title: 'unknown-tool',
      subtitle: 'unknown-tool',
    });
  });

  it('uses the running/completed state title for the generic subtitle', () => {
    expect(
      getDisplay(
        makeToolPart('mcp', {
          status: 'running',
          input: {},
          title: 'Custom title',
          time: { start: 0 },
        })
      )
    ).toEqual({ title: 'mcp', subtitle: 'Custom title' });
  });
});

describe('getToolDisplay badge rules', () => {
  it('builds the read badge from offset and limit', () => {
    expect(
      getDisplay(makeToolPart('read', completed({ filePath: '/a/b.ts', offset: 10, limit: 25 })))
        .badge
    ).toBe('L10, 25 lines');
    expect(
      getDisplay(makeToolPart('read', completed({ filePath: '/a/b.ts', offset: 10 }))).badge
    ).toBe('L10');
    expect(
      getDisplay(makeToolPart('read', completed({ filePath: '/a/b.ts', limit: 25 }))).badge
    ).toBe('25 lines');
  });

  it('omits the read badge when neither offset nor limit is set', () => {
    expect(
      getDisplay(makeToolPart('read', completed({ filePath: '/a/b.ts' }))).badge
    ).toBeUndefined();
  });

  it('counts non-empty glob output lines as the file badge', () => {
    expect(
      getDisplay(makeToolPart('glob', completed({ pattern: '**/*.ts' }, 'a.ts\n\nb.ts\n'))).badge
    ).toBe('2 files');
  });

  it('omits the glob badge without completed output', () => {
    expect(
      getDisplay(makeToolPart('glob', completed({ pattern: '**/*.ts' }, ''))).badge
    ).toBeUndefined();
    expect(getDisplay(makeToolPart('glob', running({ pattern: '**/*.ts' }))).badge).toBeUndefined();
  });

  it('counts non-empty grep output lines as the matches badge', () => {
    expect(
      getDisplay(makeToolPart('grep', completed({ pattern: 'foo' }, 'a.ts:1\nb.ts:2\nc.ts:3\n')))
        .badge
    ).toBe('3 matches');
  });

  it('omits the grep badge without completed output', () => {
    expect(
      getDisplay(makeToolPart('grep', completed({ pattern: 'foo' }, ''))).badge
    ).toBeUndefined();
    expect(getDisplay(makeToolPart('grep', running({ pattern: 'foo' }))).badge).toBeUndefined();
  });
});

describe('toolPartHasDetails', () => {
  it('returns false for suggest even with input', () => {
    expect(toolPartHasDetails(makeToolPart('suggest', completed({ prompt: 'hi' })))).toBe(false);
  });

  it('returns false for a running part with empty input and no output', () => {
    expect(toolPartHasDetails(makeToolPart('bash', running()))).toBe(false);
  });

  it('returns false for an empty completed part', () => {
    expect(toolPartHasDetails(makeToolPart('bash', completed()))).toBe(false);
  });

  it('returns true when input exists', () => {
    expect(toolPartHasDetails(makeToolPart('bash', running({ command: 'ls' })))).toBe(true);
  });

  it('returns true when completed output exists', () => {
    expect(toolPartHasDetails(makeToolPart('bash', completed({ command: 'ls' }, 'done')))).toBe(
      true
    );
  });

  it('returns true when error content exists', () => {
    expect(toolPartHasDetails(makeToolPart('bash', errorState({ command: 'ls' }, 'boom')))).toBe(
      true
    );
  });

  it('returns true when a completed part has an image attachment', () => {
    const part = makeToolPart('read', {
      status: 'completed',
      input: {},
      output: '',
      title: '',
      metadata: {},
      time: { start: 0, end: 1 },
      attachments: [makeAttachment('image/png')],
    });
    expect(toolPartHasDetails(part)).toBe(true);
  });
});
