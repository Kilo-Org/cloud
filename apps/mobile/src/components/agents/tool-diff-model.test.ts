// oxlint-disable max-lines
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { buildToolDiffModel } from './tool-diff-model';

function mustBe<T>(value: T | null, message: string): NonNullable<T> {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function makeEditToolPart(overrides: {
  filePath?: string;
  oldString?: string;
  newString?: string;
}): ToolPart {
  const input: Record<string, unknown> = {
    filePath: overrides.filePath ?? 'src/app.tsx',
    oldString: overrides.oldString ?? '',
    newString: overrides.newString ?? '',
  };
  return {
    id: 'edit-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'edit',
    state: {
      status: 'completed',
      input,
      output: '',
      title: 'edit',
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

function makeWriteToolPart(overrides: { filePath?: string; content?: string }): ToolPart {
  const input: Record<string, unknown> = {
    filePath: overrides.filePath ?? 'src/new.ts',
    content: overrides.content ?? '',
  };
  return {
    id: 'write-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool' as const,
    callID: 'call-1',
    tool: 'write',
    state: {
      status: 'completed',
      input,
      output: '',
      title: 'write',
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

describe('buildToolDiffModel — edit tool', () => {
  it('returns deleted and added numbered DiffLine rows for a valid edit', () => {
    const part = makeEditToolPart({
      oldString: 'line1\nline2',
      newString: 'new1\nnew2\nnew3',
    });
    const model = mustBe(buildToolDiffModel(part), 'edit model');
    expect(model.tool).toBe('edit');
    expect(model.language).toBe('typescript');
    expect(model.truncated).toBe(false);

    const { lines } = model;
    expect(lines).toHaveLength(5);

    // Deleted rows
    expect(lines[0]).toEqual({
      type: 'del',
      oldLine: 1,
      text: 'line1',
      noNewlineAtEndOfFile: false,
    });
    expect(lines[1]).toEqual({
      type: 'del',
      oldLine: 2,
      text: 'line2',
      noNewlineAtEndOfFile: false,
    });

    // Added rows — independently numbered from 1
    expect(lines[2]).toEqual({
      type: 'add',
      newLine: 1,
      text: 'new1',
      noNewlineAtEndOfFile: false,
    });
    expect(lines[3]).toEqual({
      type: 'add',
      newLine: 2,
      text: 'new2',
      noNewlineAtEndOfFile: false,
    });
    expect(lines[4]).toEqual({
      type: 'add',
      newLine: 3,
      text: 'new3',
      noNewlineAtEndOfFile: false,
    });
  });

  it('returns added rows only when oldString is empty', () => {
    const part = makeEditToolPart({ oldString: '', newString: 'a\nb' });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.lines).toHaveLength(2);
    expect(model.lines[0]).toEqual({
      type: 'add',
      newLine: 1,
      text: 'a',
      noNewlineAtEndOfFile: false,
    });
    expect(model.lines[1]).toEqual({
      type: 'add',
      newLine: 2,
      text: 'b',
      noNewlineAtEndOfFile: false,
    });
  });

  it('returns deleted rows only when newString is empty', () => {
    const part = makeEditToolPart({ oldString: 'x\ny', newString: '' });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.lines).toHaveLength(2);
    expect(model.lines[0]).toEqual({
      type: 'del',
      oldLine: 1,
      text: 'x',
      noNewlineAtEndOfFile: false,
    });
    expect(model.lines[1]).toEqual({
      type: 'del',
      oldLine: 2,
      text: 'y',
      noNewlineAtEndOfFile: false,
    });
  });

  it('returns null when both oldString and newString are empty', () => {
    const part = makeEditToolPart({ oldString: '', newString: '' });
    expect(buildToolDiffModel(part)).toBeNull();
  });

  it('returns a valid model when filePath is empty but content exists', () => {
    const part = makeEditToolPart({ filePath: '', oldString: 'x', newString: 'y' });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.filePath).toBe('');
    expect(model.language).toBeNull();
  });

  it('truncates oldString and newString at the character cap', () => {
    const longOld = 'a'.repeat(EDIT_CHAR_CAP + 50);
    const longNew = 'b'.repeat(EDIT_CHAR_CAP + 10);
    const part = makeEditToolPart({ oldString: longOld, newString: longNew });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.truncated).toBe(true);

    // Each side capped: no line exceeds EDIT_CHAR_CAP combined.
    const oldLines = model.lines.filter(l => l.type === 'del');
    const newLines = model.lines.filter(l => l.type === 'add');
    const oldChars = oldLines.reduce((sum, l) => sum + l.text.length, 0);
    const newChars = newLines.reduce((sum, l) => sum + l.text.length, 0);
    expect(oldChars).toBeLessThanOrEqual(EDIT_CHAR_CAP);
    expect(newChars).toBeLessThanOrEqual(EDIT_CHAR_CAP);
  });

  it('truncates at the line cap', () => {
    const manyLines = Array.from({ length: EDIT_LINE_CAP + 10 }, (_, i) => `line${i}`).join('\n');
    const part = makeEditToolPart({ oldString: manyLines, newString: 'y' });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.truncated).toBe(true);
    const oldLines = model.lines.filter(l => l.type === 'del');
    expect(oldLines).toHaveLength(EDIT_LINE_CAP);
  });

  it('strips CR from CRLF and bare-CR edit input', () => {
    const part = makeEditToolPart({
      oldString: 'alpha\r\nbeta',
      newString: 'gamma\r\ndelta\r\nepsilon',
    });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.lines).toHaveLength(5);
    expect(model.lines[0]).toMatchObject({ type: 'del', oldLine: 1, text: 'alpha' });
    expect(model.lines[1]).toMatchObject({ type: 'del', oldLine: 2, text: 'beta' });
    expect(model.lines[2]).toMatchObject({ type: 'add', newLine: 1, text: 'gamma' });
    expect(model.lines[3]).toMatchObject({ type: 'add', newLine: 2, text: 'delta' });
    expect(model.lines[4]).toMatchObject({ type: 'add', newLine: 3, text: 'epsilon' });

    const barePart = makeEditToolPart({
      oldString: 'one\rtwo',
      newString: 'three\rfour',
    });
    const bareModel = mustBe(buildToolDiffModel(barePart), 'model');
    expect(bareModel.lines[0]).toMatchObject({ type: 'del', oldLine: 1, text: 'one' });
    expect(bareModel.lines[1]).toMatchObject({ type: 'del', oldLine: 2, text: 'two' });
    expect(bareModel.lines[2]).toMatchObject({ type: 'add', newLine: 1, text: 'three' });
    expect(bareModel.lines[3]).toMatchObject({ type: 'add', newLine: 2, text: 'four' });
  });
});

describe('buildToolDiffModel — write tool', () => {
  it('returns added numbered DiffLine rows for a valid write', () => {
    const part = makeWriteToolPart({ content: 'line1\nline2\nline3' });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.tool).toBe('write');
    expect(model.truncated).toBe(false);

    const { lines } = model;
    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({
      type: 'add',
      newLine: 1,
      text: 'line1',
      noNewlineAtEndOfFile: false,
    });
    expect(lines[1]).toEqual({
      type: 'add',
      newLine: 2,
      text: 'line2',
      noNewlineAtEndOfFile: false,
    });
    expect(lines[2]).toEqual({
      type: 'add',
      newLine: 3,
      text: 'line3',
      noNewlineAtEndOfFile: false,
    });
  });

  it('resolves language for .js files to javascript', () => {
    const part = makeWriteToolPart({ filePath: 'src/foo.js', content: 'x' });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.language).toBe('javascript');
  });

  it('resolves language to null for unknown extensions', () => {
    const part = makeWriteToolPart({ filePath: 'Makefile', content: 'x' });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.language).toBeNull();
  });

  it('returns null when content is empty', () => {
    const part = makeWriteToolPart({ content: '' });
    expect(buildToolDiffModel(part)).toBeNull();
  });

  it('returns a valid model for whitespace-only content (blank lines)', () => {
    const part = makeWriteToolPart({ content: '\n\n' });
    // splitTrimTrailingEmpty removes the final empty, but keeps \n lines.
    const model = buildToolDiffModel(part);
    // Two non-empty entries from ["", ""] after trailing pop.
    expect(model).not.toBeNull();
  });

  it('returns null when content is missing (undefined treated as empty)', () => {
    const part = makeWriteToolPart({ content: undefined });
    expect(buildToolDiffModel(part)).toBeNull();
  });

  it('truncates content at the character cap', () => {
    const longContent = 'x'.repeat(WRITE_CHAR_CAP + 100);
    const part = makeWriteToolPart({ content: longContent });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.truncated).toBe(true);
    const totalChars =
      model.lines.reduce((sum, l) => sum + l.text.length, 0) + (model.lines.length - 1);
    expect(totalChars).toBeLessThanOrEqual(WRITE_CHAR_CAP);
  });

  it('truncates at the line cap', () => {
    const manyLines = Array.from({ length: WRITE_LINE_CAP + 10 }, (_, i) => `line${i}`).join('\n');
    const part = makeWriteToolPart({ content: manyLines });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.truncated).toBe(true);
    expect(model.lines).toHaveLength(WRITE_LINE_CAP);
  });

  it('strips CR from CRLF, bare-CR, and mixed write content', () => {
    const crlfPart = makeWriteToolPart({ content: 'alpha\r\nbeta\r\ncharlie' });
    const crlfModel = mustBe(buildToolDiffModel(crlfPart), 'model');
    expect(crlfModel.lines).toHaveLength(3);
    expect(crlfModel.lines[0]).toMatchObject({ type: 'add', newLine: 1, text: 'alpha' });
    expect(crlfModel.lines[1]).toMatchObject({ type: 'add', newLine: 2, text: 'beta' });
    expect(crlfModel.lines[2]).toMatchObject({ type: 'add', newLine: 3, text: 'charlie' });

    const barePart = makeWriteToolPart({ content: 'one\rtwo' });
    const bareModel = mustBe(buildToolDiffModel(barePart), 'model');
    expect(bareModel.lines).toHaveLength(2);
    expect(bareModel.lines[0]).toMatchObject({ type: 'add', newLine: 1, text: 'one' });
    expect(bareModel.lines[1]).toMatchObject({ type: 'add', newLine: 2, text: 'two' });

    const mixedPart = makeWriteToolPart({ content: 'line1\nline2\r\nline3' });
    const mixedModel = mustBe(buildToolDiffModel(mixedPart), 'model');
    expect(mixedModel.lines).toHaveLength(3);
    expect(mixedModel.lines[0]).toMatchObject({ type: 'add', newLine: 1, text: 'line1' });
    expect(mixedModel.lines[1]).toMatchObject({ type: 'add', newLine: 2, text: 'line2' });
    expect(mixedModel.lines[2]).toMatchObject({ type: 'add', newLine: 3, text: 'line3' });
  });
});

describe('buildToolDiffModel — non-diff tools', () => {
  it('returns null for a bash tool part', () => {
    const part: ToolPart = {
      id: 'bash-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'ls' },
        output: 'done',
        title: 'bash',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    };
    expect(buildToolDiffModel(part)).toBeNull();
  });

  it('returns null for an unknown tool name', () => {
    const part: ToolPart = {
      id: 'x-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'unknown-tool',
      state: {
        status: 'completed',
        input: {},
        output: '',
        title: '',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    };
    expect(buildToolDiffModel(part)).toBeNull();
  });
});

// Constants from the model, duplicated here for focused assertion.
const EDIT_CHAR_CAP = 1000;
const EDIT_LINE_CAP = 100;
const WRITE_CHAR_CAP = 2000;
const WRITE_LINE_CAP = 200;
