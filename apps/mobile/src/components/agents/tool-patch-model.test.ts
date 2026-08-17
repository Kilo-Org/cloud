// oxlint-disable max-lines
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { describe, expect, it } from 'vitest';

import { buildToolPatchModel, listPatchFilePaths } from './tool-patch-model';

function mustBe<T>(value: T | null, message: string): NonNullable<T> {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function makePatchPart(tool: string, patchText: string): ToolPart {
  return {
    id: 'patch-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state: {
      status: 'completed',
      input: { patchText },
      output: '',
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

/** Build an update file whose chunk body is exactly `count` context lines. */
function updateFileWithContextLines(path: string, count: number): string {
  const body = Array.from({ length: count }, (_, i) => ` line${i + 1}`).join('\n');
  return `*** Update File: ${path}\n@@\n${body}`;
}

const ENVELOPE = {
  open: '*** Begin Patch\n',
  close: '*** End Patch',
} as const;

const PATCH_FILE_CAP = 50;
const PATCH_FILE_LINE_CAP = 500;
const PATCH_TOTAL_LINE_CAP = 2000;

describe('buildToolPatchModel — update files', () => {
  it('parses a single update file with context, del, and add rows numbered from one', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/app.ts
@@
 const answer = 42;
-old line
+new line
${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');

    expect(model.truncated).toBe(false);
    expect(model.files).toHaveLength(1);
    const file = model.files[0];
    if (!file) {
      throw new Error('file missing');
    }
    expect(file).toMatchObject({ path: 'src/app.ts', operation: 'update', language: 'typescript' });
    expect(file.lines).toEqual([
      {
        type: 'context',
        oldLine: 1,
        newLine: 1,
        text: 'const answer = 42;',
        noNewlineAtEndOfFile: false,
      },
      { type: 'del', oldLine: 2, text: 'old line', noNewlineAtEndOfFile: false },
      { type: 'add', newLine: 2, text: 'new line', noNewlineAtEndOfFile: false },
    ]);
  });

  it('parses multiple chunks with per-file counters continuing across chunks', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/app.ts
@@
-1
+2
@@
 ctx
-3
+4
${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    const file = model.files[0];
    if (!file) {
      throw new Error('file missing');
    }
    expect(file.lines).toEqual([
      { type: 'del', oldLine: 1, text: '1', noNewlineAtEndOfFile: false },
      { type: 'add', newLine: 1, text: '2', noNewlineAtEndOfFile: false },
      { type: 'context', oldLine: 2, newLine: 2, text: 'ctx', noNewlineAtEndOfFile: false },
      { type: 'del', oldLine: 3, text: '3', noNewlineAtEndOfFile: false },
      { type: 'add', newLine: 3, text: '4', noNewlineAtEndOfFile: false },
    ]);
  });

  it('consumes an End of File marker mid-chunk', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/app.ts
@@
-old
+new
*** End of File
${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    const file = model.files[0];
    if (!file) {
      throw new Error('file missing');
    }
    expect(file.lines).toHaveLength(2);
    expect(file.lines[0]).toEqual({
      type: 'del',
      oldLine: 1,
      text: 'old',
      noNewlineAtEndOfFile: false,
    });
    expect(file.lines[1]).toEqual({
      type: 'add',
      newLine: 1,
      text: 'new',
      noNewlineAtEndOfFile: false,
    });
  });

  it('accepts an End of File marker followed by another chunk', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/app.ts
@@
-old1
+new1
*** End of File
@@
-old2
+new2
${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    const file = model.files[0];
    if (!file) {
      throw new Error('file missing');
    }
    expect(file.lines).toHaveLength(4);
    expect(file.lines[2]).toEqual({
      type: 'del',
      oldLine: 2,
      text: 'old2',
      noNewlineAtEndOfFile: false,
    });
    expect(file.lines[3]).toEqual({
      type: 'add',
      newLine: 2,
      text: 'new2',
      noNewlineAtEndOfFile: false,
    });
  });

  it('fails when End of File appears directly after the update header (zero chunks)', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/app.ts
*** End of File
${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('terminates a chunk at the next file op and continues the file-op loop', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/a.ts
@@
-old
+new
*** Add File: src/b.ts
+x
${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    expect(model.files.map(f => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    const first = model.files[0];
    if (!first) {
      throw new Error('first file missing');
    }
    expect(first.lines).toHaveLength(2);
  });

  it('fails on a bad chunk line', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/app.ts
@@
garbage line
${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('ignores @@ context text and move-to headers for the row model', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/app.ts
*** Move to: src/renamed.ts
@@ some anchoring context
-old
+new
${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    const file = model.files[0];
    if (!file) {
      throw new Error('file missing');
    }
    expect(file.path).toBe('src/app.ts');
    expect(file.lines).toHaveLength(2);
  });

  it('returns null for an empty move-to path', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/app.ts
*** Move to:
@@
-old
+new
${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('returns null for a whitespace-only move-to path', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/app.ts
*** Move to:${'   '}
@@
-old
+new
${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });
});

describe('buildToolPatchModel — add, delete, multi-file', () => {
  it('parses an add file with numbered added rows', () => {
    const patchText = `${ENVELOPE.open}*** Add File: src/new.js
+line1
+line2
${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    const file = model.files[0];
    if (!file) {
      throw new Error('file missing');
    }
    expect(file).toMatchObject({ path: 'src/new.js', operation: 'add', language: 'javascript' });
    expect(file.lines).toEqual([
      { type: 'add', newLine: 1, text: 'line1', noNewlineAtEndOfFile: false },
      { type: 'add', newLine: 2, text: 'line2', noNewlineAtEndOfFile: false },
    ]);
  });

  it('parses an add file with zero content lines as a valid header-only file', () => {
    const patchText = `${ENVELOPE.open}*** Add File: src/empty.ts
${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    const file = model.files[0];
    if (!file) {
      throw new Error('file missing');
    }
    expect(file).toMatchObject({ path: 'src/empty.ts', operation: 'add' });
    expect(file.lines).toEqual([]);
  });

  it('parses a delete file with no rows', () => {
    const patchText = `${ENVELOPE.open}*** Delete File: src/gone.ts
${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    const file = model.files[0];
    if (!file) {
      throw new Error('file missing');
    }
    expect(file).toMatchObject({
      path: 'src/gone.ts',
      operation: 'delete',
      language: 'typescript',
    });
    expect(file.lines).toEqual([]);
  });

  it('keeps multi-file patch ordering', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/a.ts
@@
-old
+new
*** Add File: src/b.ts
+x
*** Delete File: src/c.ts
${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    expect(model.files.map(f => [f.path, f.operation])).toEqual([
      ['src/a.ts', 'update'],
      ['src/b.ts', 'add'],
      ['src/c.ts', 'delete'],
    ]);
  });

  it('ignores text outside the Begin/End envelope', () => {
    const patchText = `preamble text
${ENVELOPE.open}*** Add File: src/a.ts
+x
${ENVELOPE.close}
trailing text`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    expect(model.files.map(f => f.path)).toEqual(['src/a.ts']);
  });
});

describe('buildToolPatchModel — input handling', () => {
  it('normalizes CRLF input before parsing', () => {
    const patchText =
      '*** Begin Patch\r\n*** Update File: src/app.ts\r\n@@\r\n-old\r\n+new\r\n*** End Patch';
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    const file = model.files[0];
    if (!file) {
      throw new Error('file missing');
    }
    expect(file.lines).toEqual([
      { type: 'del', oldLine: 1, text: 'old', noNewlineAtEndOfFile: false },
      { type: 'add', newLine: 1, text: 'new', noNewlineAtEndOfFile: false },
    ]);
  });

  it('returns null when Begin is missing', () => {
    const patchText = '*** Update File: src/a.ts\n@@\n-old\n+new';
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('returns null when End is missing', () => {
    const patchText = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new';
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('returns null when End appears before Begin', () => {
    const patchText = '*** End Patch\n*** Begin Patch\n*** Add File: src/a.ts\n+x';
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('returns null for an update with zero chunks', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/a.ts
${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('returns null for a bad add-file content line', () => {
    const patchText = `${ENVELOPE.open}*** Add File: src/a.ts
no-plus-prefix
${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('returns null for an invalid line in the file-op loop', () => {
    const patchText = `${ENVELOPE.open}*** Bogus File: src/a.ts
${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('returns null for an empty envelope with no files', () => {
    const patchText = `${ENVELOPE.open}${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('returns null for an empty patchText', () => {
    expect(buildToolPatchModel(makePatchPart('apply_patch', ''))).toBeNull();
  });

  it('returns null when patchText is missing', () => {
    const part = makePatchPart('apply_patch', '');
    part.state = { ...part.state, input: {} };
    expect(buildToolPatchModel(part)).toBeNull();
  });

  it('returns null for a non-patch tool even with a valid patch', () => {
    const patchText = `${ENVELOPE.open}*** Add File: src/a.ts
+x
${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('edit', patchText))).toBeNull();
  });

  it('accepts both the patch and apply_patch tool names', () => {
    const patchText = `${ENVELOPE.open}*** Add File: src/a.ts
+x
${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('patch', patchText))).not.toBeNull();
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).not.toBeNull();
  });

  it('returns a model for a pending part with parseable input (no status gate)', () => {
    const patchText = `${ENVELOPE.open}*** Add File: src/a.ts
+x
${ENVELOPE.close}`;
    const part = makePatchPart('apply_patch', patchText);
    part.state = { status: 'pending', input: { patchText }, raw: '' };
    expect(buildToolPatchModel(part)).not.toBeNull();
  });

  it('returns a model for a running part with parseable input (no status gate)', () => {
    const patchText = `${ENVELOPE.open}*** Add File: src/a.ts
+x
${ENVELOPE.close}`;
    const part = makePatchPart('apply_patch', patchText);
    part.state = { status: 'running', input: { patchText }, time: { start: 0 } };
    expect(buildToolPatchModel(part)).not.toBeNull();
  });
});

describe('buildToolPatchModel — caps', () => {
  it('retains at most PATCH_FILE_CAP files and drops later files entirely', () => {
    const fileOps = Array.from(
      { length: PATCH_FILE_CAP + 1 },
      (_, i) => `*** Add File: src/f${i}.ts\n+x`
    ).join('\n');
    const patchText = `${ENVELOPE.open}${fileOps}\n${ENVELOPE.close}`;

    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    expect(model.truncated).toBe(true);
    expect(model.files).toHaveLength(PATCH_FILE_CAP);
    const retainedPaths = model.files.map(f => f.path);
    expect(retainedPaths).toContain('src/f49.ts');
    expect(retainedPaths).not.toContain('src/f50.ts');
  });

  it('slices a file at PATCH_FILE_LINE_CAP while keeping its header', () => {
    const patchText = `${ENVELOPE.open}${updateFileWithContextLines('src/big.ts', 600)}\n${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    expect(model.truncated).toBe(true);
    const file = model.files[0];
    if (!file) {
      throw new Error('file missing');
    }
    expect(file.path).toBe('src/big.ts');
    expect(file.lines).toHaveLength(PATCH_FILE_LINE_CAP);
    expect(file.lines.at(-1)).toMatchObject({ type: 'context', text: 'line500' });
  });

  it('enforces the exact total line budget with partial retention and later drops', () => {
    const patchText = [
      '*** Begin Patch',
      updateFileWithContextLines('src/f1.ts', 499),
      updateFileWithContextLines('src/f2.ts', 499),
      updateFileWithContextLines('src/f3.ts', 1000),
      updateFileWithContextLines('src/f4.ts', 503),
      updateFileWithContextLines('src/f5.ts', 400),
      '*** Add File: src/f6.ts\n+x',
      '*** End Patch',
    ].join('\n');

    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    expect(model.truncated).toBe(true);
    expect(model.files.map(f => f.path)).toEqual([
      'src/f1.ts',
      'src/f2.ts',
      'src/f3.ts',
      'src/f4.ts',
      'src/f5.ts',
    ]);
    const totalLines = model.files.reduce((sum, f) => sum + f.lines.length, 0);
    expect(totalLines).toBe(PATCH_TOTAL_LINE_CAP);
    const partial = model.files.at(-1);
    if (!partial) {
      throw new Error('partial file missing');
    }
    expect(partial.path).toBe('src/f5.ts');
    expect(partial.lines).toHaveLength(2);
    expect(partial.lines[0]).toEqual({
      type: 'context',
      oldLine: 1,
      newLine: 1,
      text: 'line1',
      noNewlineAtEndOfFile: false,
    });
    expect(partial.lines[1]).toEqual({
      type: 'context',
      oldLine: 2,
      newLine: 2,
      text: 'line2',
      noNewlineAtEndOfFile: false,
    });
  });

  it('keeps delete files (zero lines) but counts them toward the file cap', () => {
    const deletes = Array.from(
      { length: PATCH_FILE_CAP },
      (_, i) => `*** Delete File: src/d${i}.ts`
    ).join('\n');
    const patchText = `${ENVELOPE.open}${deletes}\n*** Add File: src/overflow.ts\n+x\n${ENVELOPE.close}`;
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    expect(model.truncated).toBe(true);
    expect(model.files).toHaveLength(PATCH_FILE_CAP);
    expect(model.files.every(f => f.operation === 'delete')).toBe(true);
  });

  it('does not mark truncated when retained lines end exactly at the total cap', () => {
    const patchText = [
      '*** Begin Patch',
      updateFileWithContextLines('src/f1.ts', 500),
      updateFileWithContextLines('src/f2.ts', 500),
      updateFileWithContextLines('src/f3.ts', 500),
      updateFileWithContextLines('src/f4.ts', 500),
      '*** End Patch',
    ].join('\n');
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    expect(model.truncated).toBe(false);
    expect(model.files).toHaveLength(4);
    const totalLines = model.files.reduce((sum, f) => sum + f.lines.length, 0);
    expect(totalLines).toBe(PATCH_TOTAL_LINE_CAP);
  });

  it('marks truncated when a later file is dropped after the total cap', () => {
    const patchText = [
      '*** Begin Patch',
      updateFileWithContextLines('src/f1.ts', 500),
      updateFileWithContextLines('src/f2.ts', 500),
      updateFileWithContextLines('src/f3.ts', 500),
      updateFileWithContextLines('src/f4.ts', 500),
      updateFileWithContextLines('src/f5.ts', 10),
      '*** End Patch',
    ].join('\n');
    const model = mustBe(buildToolPatchModel(makePatchPart('apply_patch', patchText)), 'model');
    expect(model.truncated).toBe(true);
    expect(model.files.map(f => f.path)).toEqual([
      'src/f1.ts',
      'src/f2.ts',
      'src/f3.ts',
      'src/f4.ts',
    ]);
    const totalLines = model.files.reduce((sum, f) => sum + f.lines.length, 0);
    expect(totalLines).toBe(PATCH_TOTAL_LINE_CAP);
  });

  it('still fails on a grammar violation after the file cap (full envelope validation)', () => {
    const fileOps = Array.from(
      { length: PATCH_FILE_CAP },
      (_, i) => `*** Add File: src/f${i}.ts\n+x`
    ).join('\n');
    const patchText = `${ENVELOPE.open}${fileOps}\n*** Add File: src/bad.ts\nno-plus-prefix\n${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });

  it('still fails on a bad chunk row after the per-file line cap', () => {
    const patchText = `${ENVELOPE.open}${updateFileWithContextLines('src/big.ts', PATCH_FILE_LINE_CAP)}
garbage
${ENVELOPE.close}`;
    expect(buildToolPatchModel(makePatchPart('apply_patch', patchText))).toBeNull();
  });
});

describe('listPatchFilePaths', () => {
  it('lists a single file path', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/app.ts
@@
-old
+new
${ENVELOPE.close}`;
    expect(listPatchFilePaths(patchText)).toEqual(['src/app.ts']);
  });

  it('lists multiple file paths in order', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/a.ts
@@
-old
+new
*** Add File: src/b.ts
+x
*** Delete File: src/c.ts
${ENVELOPE.close}`;
    expect(listPatchFilePaths(patchText)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('returns an empty list without the envelope even when headers exist', () => {
    const patchText = '*** Add File: src/a.ts\n+x\n*** Update File: src/b.ts';
    expect(listPatchFilePaths(patchText)).toEqual([]);
  });

  it('ignores file headers outside the envelope', () => {
    const patchText = `*** Update File: src/before.ts
${ENVELOPE.open}*** Add File: src/inside.ts
+x
${ENVELOPE.close}
*** Update File: src/after.ts`;
    expect(listPatchFilePaths(patchText)).toEqual(['src/inside.ts']);
  });

  it('returns an empty list for an empty string', () => {
    expect(listPatchFilePaths('')).toEqual([]);
  });

  it('scans paths from a patch whose chunk grammar is corrupt (header label authority)', () => {
    const patchText = `${ENVELOPE.open}*** Update File: src/a.ts
@@
garbage
${ENVELOPE.close}`;
    expect(listPatchFilePaths(patchText)).toEqual(['src/a.ts']);
  });

  it('strips \r from CRLF paths', () => {
    const patchText = '*** Begin Patch\r\n*** Add File: src/a.ts\r\n+x\r\n*** End Patch';
    expect(listPatchFilePaths(patchText)).toEqual(['src/a.ts']);
  });
});
