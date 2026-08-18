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
    const longOld = 'a'.repeat(EDIT_CHARACTER_CAP + 50);
    const longNew = 'b'.repeat(EDIT_CHARACTER_CAP + 10);
    const part = makeEditToolPart({ oldString: longOld, newString: longNew });
    const model = mustBe(buildToolDiffModel(part), 'model');
    expect(model.truncated).toBe(true);

    // Each side capped: no line exceeds EDIT_CHARACTER_CAP combined.
    const oldLines = model.lines.filter(l => l.type === 'del');
    const newLines = model.lines.filter(l => l.type === 'add');
    const oldChars = oldLines.reduce((sum, l) => sum + l.text.length, 0);
    const newChars = newLines.reduce((sum, l) => sum + l.text.length, 0);
    expect(oldChars).toBeLessThanOrEqual(EDIT_CHARACTER_CAP);
    expect(newChars).toBeLessThanOrEqual(EDIT_CHARACTER_CAP);
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
const EDIT_CHARACTER_CAP = 10_000;
const EDIT_LINE_CAP = 500;
