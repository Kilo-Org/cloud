import {
  countLines,
  getUnifiedPatch,
  readApplyPatchFiles,
  readFileToolMetadata,
  readToolDiagnostics,
  sumFileChanges,
} from './toolDiffUtils';

const patch = '--- src/a.ts\n+++ src/a.ts\n@@ -90,1 +90,1 @@\n-before\n+after\n';

describe('file tool metadata', () => {
  it('retains valid fields when neighboring metadata is malformed', () => {
    expect(
      readFileToolMetadata({
        filediff: { file: 'src/a.ts', patch: 42, additions: 3, deletions: -1 },
        diagnostics: null,
      })
    ).toEqual({
      filediff: { file: 'src/a.ts', patch: undefined, additions: 3, deletions: undefined },
      diagnostics: undefined,
    });
  });

  it.each([undefined, null, [], 'invalid', 42])('ignores non-object metadata: %p', value => {
    expect(readFileToolMetadata(value)).toEqual({});
    expect(readApplyPatchFiles(value)).toEqual([]);
  });

  it('keeps good file summaries despite malformed entries, counts, and patches', () => {
    const files = readApplyPatchFiles({
      files: [
        null,
        'invalid',
        {},
        { filePath: 42, relativePath: '' },
        {
          filePath: '/workspace/src/a.ts',
          relativePath: 'src/a.ts',
          type: 'add',
          patch,
          additions: 1,
          deletions: 0,
        },
        {
          relativePath: 'src/b.ts',
          type: 'unknown',
          patch: { text: patch },
          diff: patch,
          additions: '2',
          deletions: 3,
        },
      ],
    });

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ relativePath: 'src/a.ts', patch, additions: 1, deletions: 0 });
    expect(files[1]).toMatchObject({
      relativePath: 'src/b.ts',
      type: undefined,
      patch: undefined,
      diff: patch,
      additions: undefined,
      deletions: 3,
    });
  });

  it('preserves the distinct source and destination of a move', () => {
    const [file] = readApplyPatchFiles({
      files: [
        {
          filePath: '/workspace/src/old.ts',
          relativePath: 'src/new.ts',
          movePath: '/workspace/src/new.ts',
          type: 'move',
          additions: 0,
          deletions: 0,
        },
      ],
    });
    expect(file).toMatchObject({
      filePath: '/workspace/src/old.ts',
      relativePath: 'src/new.ts',
      movePath: '/workspace/src/new.ts',
      type: 'move',
    });
  });

  it('totals known counts without treating a missing count as zero', () => {
    expect(
      sumFileChanges([
        { additions: 3, deletions: 0 },
        { additions: 0, deletions: 2 },
        { additions: 1, deletions: 1 },
      ])
    ).toEqual({ additions: 4, deletions: 3 });
    expect(sumFileChanges([{ additions: 3, deletions: 0 }, { deletions: 2 }])).toEqual({
      additions: undefined,
      deletions: 2,
    });
    expect(sumFileChanges([])).toEqual({ additions: undefined, deletions: undefined });
  });
});

describe('unified patch recognition', () => {
  it('retains the supplied hunk positions rather than reconstructing file contents', () => {
    expect(getUnifiedPatch(patch)).toBe(patch);
    expect(getUnifiedPatch(patch.replaceAll('\n', '\r\n'))).toBe(patch.replaceAll('\n', '\r\n'));
  });

  it.each([
    '--- src/new.ts\n+++ src/new.ts\n@@ -0,0 +1,2 @@\n+first\n+second\n',
    '--- src/deleted.ts\n+++ src/deleted.ts\n@@ -1,2 +0,0 @@\n-first\n-second\n',
  ])('accepts addition and deletion patches with an empty side', value => {
    expect(getUnifiedPatch(value)).toBe(value);
  });

  it.each([
    undefined,
    null,
    42,
    '',
    'not a patch',
    '--- src/a.ts\n+++ src/a.ts\n',
    '--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n',
    '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-before\n+after\n*** End Patch',
  ])('rejects absent, sparse, and non-unified payloads: %p', value => {
    expect(getUnifiedPatch(value)).toBeUndefined();
  });
});

describe('written line counts', () => {
  it.each([
    ['', 0],
    ['one', 1],
    ['one\n', 1],
    ['one\ntwo\n', 2],
    ['\n', 1],
    ['\n\n', 2],
  ])('counts %p without a phantom trailing line', (content, expected) => {
    expect(countLines(content)).toBe(expected);
  });
});

describe('tool diagnostics', () => {
  it('selects at most three valid severity-one excerpts for the requested file', () => {
    const diagnostics = readToolDiagnostics(
      {
        '/workspace/src/a.ts': [
          null,
          { severity: 2, message: 'warning' },
          { severity: '1', message: 'wrong severity type' },
          { severity: 1, message: 42 },
          { severity: 1, message: '  ' },
          { severity: 1, message: 'first', range: { start: { line: 1, character: 2 } } },
          { severity: 1, message: 'second', range: { start: { line: -1, character: 2 } } },
          { severity: 1, message: 'x'.repeat(401) },
          { severity: 1, message: 'fourth' },
        ],
        '/workspace/src/b.ts': [{ severity: 1, message: 'other file' }],
      },
      '/workspace/src/a.ts'
    );

    expect(diagnostics).toHaveLength(3);
    expect(diagnostics[0]).toMatchObject({
      message: 'first',
      range: { start: { line: 1, character: 2 } },
    });
    expect(diagnostics[1]).toMatchObject({ message: 'second', range: undefined });
    expect(diagnostics[2].message).toBe(`${'x'.repeat(400)}…`);
  });

  it('ignores invalid collections and unmatched files', () => {
    expect(readToolDiagnostics(null, '/workspace/src/a.ts')).toEqual([]);
    expect(readToolDiagnostics({ '/workspace/src/a.ts': {} }, '/workspace/src/a.ts')).toEqual([]);
    expect(readToolDiagnostics({}, undefined)).toEqual([]);
  });
});
