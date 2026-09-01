import { describe, expect, it } from 'vitest';
import {
  MAX_WORKTREE_CHANGES_BYTES,
  MAX_WORKTREE_CHANGES_FILES,
  MAX_WORKTREE_CONTENT_BYTES,
  MAX_WORKTREE_CONTENT_LINES,
  MAX_WORKTREE_FILE_BYTES,
  MAX_WORKTREE_PATCH_LINES,
  MAX_WORKTREE_SNAPSHOT_BYTES,
  WORKTREE_FILE_SCHEMA_VERSION,
  getWorktreeChangesOutputSchema,
  getWorktreeFileOutputSchema,
  refreshWorktreeChangesOutputSchema,
  worktreeChangesCaptureRequestSchema,
  worktreeChangesCaptureSchema,
  worktreeChangesFileSchema,
  worktreeChangesSnapshotSchema,
  worktreeFileQuerySchema,
  worktreeFileRecordSchema,
  worktreeSnapshotCaptureSchema,
  type WorktreeChangesFile,
  type WorktreeChangesSnapshot,
  type WorktreeFileRecord,
} from './cloud-agent-worktree-changes.js';

const file: WorktreeChangesFile = {
  path: 'src/example.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  tracked: true,
  binary: false,
  countsComplete: true,
};
const snapshot: WorktreeChangesSnapshot = {
  schemaVersion: 1,
  revision: 3,
  capturedAt: '2026-08-26T12:00:00.000Z',
  comparison: {
    baseRef: 'refs/remotes/origin/main',
    mergeBase: 'a'.repeat(40),
    head: 'b'.repeat(40),
  },
  files: [file],
  truncated: false,
};

function capture(files = snapshot.files) {
  return { revision: snapshot.revision, comparison: snapshot.comparison, files, truncated: false };
}

const savedFile = {
  schemaVersion: WORKTREE_FILE_SCHEMA_VERSION,
  revision: snapshot.revision,
  path: file.path,
  diff: {
    status: 'available',
    patch:
      'diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1,2 @@\n-old\n+new\n+more\n',
  },
  content: { status: 'available', source: 'current', text: 'new\nmore\n' },
} satisfies WorktreeFileRecord;

describe('cloud agent worktree changes contracts', () => {
  it('distinguishes no saved snapshot from a successful empty capture', () => {
    expect(getWorktreeChangesOutputSchema.parse({ snapshot: null })).toEqual({ snapshot: null });
    const empty = { ...snapshot, files: [] };
    expect(
      refreshWorktreeChangesOutputSchema.parse({ status: 'refreshed', snapshot: empty })
    ).toEqual({
      status: 'refreshed',
      snapshot: empty,
    });
    expect(
      refreshWorktreeChangesOutputSchema.safeParse({ status: 'refreshed', snapshot: null }).success
    ).toBe(false);
    for (const status of ['offline', 'failed']) {
      expect(refreshWorktreeChangesOutputSchema.parse({ status, snapshot })).toEqual({
        status,
        snapshot,
      });
      expect(refreshWorktreeChangesOutputSchema.parse({ status, snapshot: null })).toEqual({
        status,
        snapshot: null,
      });
    }
  });

  it.each([
    { schemaVersion: 2 },
    { revision: 0 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { capturedAt: 'not a timestamp' },
    { comparison: { ...snapshot.comparison, head: 'HEAD' } },
    { comparison: { ...snapshot.comparison, mergeBase: '' } },
    { patch: 'unexpected file contents' },
  ])('rejects unsupported or malformed persisted records %j', invalid => {
    expect(worktreeChangesSnapshotSchema.safeParse({ ...snapshot, ...invalid }).success).toBe(
      false
    );
  });

  it('accepts SHA-256 object IDs without weakening commit validation', () => {
    expect(
      worktreeChangesSnapshotSchema.safeParse({
        ...snapshot,
        comparison: { ...snapshot.comparison, head: 'b'.repeat(64), mergeBase: 'a'.repeat(64) },
      }).success
    ).toBe(true);
  });

  it.each([
    '/outside',
    '../outside',
    'parent/../outside',
    'parent//file',
    './file',
    'file\0suffix',
  ])('rejects unsafe paths %j', path => {
    expect(worktreeChangesFileSchema.safeParse({ ...file, path }).success).toBe(false);
  });

  it('preserves ordinary unusual filenames exactly', () => {
    const path = 'parent/ leading\tline\n"back\\slash-é-漢 ';
    expect(worktreeChangesFileSchema.parse({ ...file, path }).path).toBe(path);
  });

  it.each([
    { additions: -1 },
    { deletions: 1.5 },
    { additions: Number.POSITIVE_INFINITY },
    { status: 'renamed' },
    { contents: 'not a file summary' },
  ])('rejects invalid file summaries %j', invalid => {
    expect(worktreeChangesFileSchema.safeParse({ ...file, ...invalid }).success).toBe(false);
  });

  it('bounds both capture and stored snapshot by UTF-8 bytes rather than string length', () => {
    const files = Array.from({ length: 24 }, (_, index) => ({
      ...file,
      path: `${index}/${'漢'.repeat(3800)}`,
    }));
    expect(JSON.stringify(capture(files)).length).toBeLessThan(MAX_WORKTREE_CHANGES_BYTES);
    expect(worktreeChangesCaptureSchema.safeParse(capture(files)).success).toBe(false);
    expect(worktreeChangesSnapshotSchema.safeParse({ ...snapshot, files }).success).toBe(false);
    expect(worktreeChangesCaptureSchema.safeParse(capture(files.slice(0, 1))).success).toBe(true);
  });

  it('bounds file count independently of bytes', () => {
    const files = Array.from({ length: MAX_WORKTREE_CHANGES_FILES + 1 }, (_, index) => ({
      ...file,
      path: `${index}`,
    }));
    expect(new TextEncoder().encode(JSON.stringify(capture(files))).byteLength).toBeLessThan(
      MAX_WORKTREE_CHANGES_BYTES
    );
    expect(worktreeChangesCaptureSchema.safeParse(capture(files)).success).toBe(false);
    expect(worktreeChangesSnapshotSchema.safeParse({ ...snapshot, files }).success).toBe(false);
  });

  it('rejects option-like refs and extra routing fields at the capture boundary', () => {
    expect(worktreeChangesCaptureRequestSchema.parse({ revision: 1 })).toEqual({ revision: 1 });
    for (const invalid of [
      { revision: 1, baseRef: '--help' },
      { revision: 1, baseRef: 'main\0suffix' },
      { revision: 1, directory: '/another-session' },
      { revision: 1, sessionId: 'another-session' },
    ]) {
      expect(worktreeChangesCaptureRequestSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe('saved worktree file contracts', () => {
  it('preserves complete files, empty content, and metadata-only patches', () => {
    for (const input of [
      savedFile,
      { ...savedFile, content: { ...savedFile.content, text: '' } },
      {
        ...savedFile,
        diff: {
          status: 'available',
          patch: 'diff --git a/empty b/empty\nold mode 100644\nnew mode 100755\n',
        },
        content: { status: 'unavailable', reason: 'too_large' },
      },
    ]) {
      expect(worktreeFileRecordSchema.parse(input)).toEqual(input);
    }
  });

  it('uses explicit omission reasons without retaining omitted bodies', () => {
    for (const reason of [
      'binary',
      'unsupported',
      'invalid_utf8',
      'too_large',
      'line_limit',
      'budget_exhausted',
      'inconsistent',
      'capture_failed',
    ]) {
      const input = {
        ...savedFile,
        diff: { status: 'omitted', reason },
        content: { status: 'unavailable', reason },
      };
      expect(worktreeFileRecordSchema.parse(input)).toEqual(input);
      expect(
        worktreeFileRecordSchema.safeParse({
          ...input,
          diff: { ...input.diff, patch: savedFile.diff.patch },
        }).success
      ).toBe(false);
      expect(
        worktreeFileRecordSchema.safeParse({
          ...input,
          content: { ...input.content, text: savedFile.content.text },
        }).success
      ).toBe(false);
    }
  });

  it('rejects malformed versions, revisions, paths, and nested records', () => {
    for (const invalid of [
      { schemaVersion: 2 },
      { revision: 0 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { path: '' },
      { path: '/outside' },
      { path: '../outside' },
      { path: 'parent/../outside' },
      { path: 'parent//file' },
      { path: './file' },
      { path: 'file\0suffix' },
      { path: 'x'.repeat(4097) },
      { diff: null },
      { diff: { status: 'available', patch: '' } },
      { diff: { status: 'available', patch: 1 } },
      { diff: { ...savedFile.diff, reason: 'capture_failed' } },
      { diff: { status: 'omitted', reason: 'unknown' } },
      { content: null },
      { content: { status: 'available', text: '' } },
      { content: { ...savedFile.content, source: 'base' } },
      { content: { ...savedFile.content, text: null } },
      { content: { ...savedFile.content, extra: true } },
      { content: { status: 'unavailable', reason: 'unknown' } },
      { extra: true },
    ]) {
      expect(worktreeFileRecordSchema.safeParse({ ...savedFile, ...invalid }).success).toBe(false);
    }
  });

  it('enforces the exclusive raw UTF-8 content limit independently of JSON escaping', () => {
    for (const text of [
      'x'.repeat(MAX_WORKTREE_CONTENT_BYTES - 1),
      '漢'.repeat((MAX_WORKTREE_CONTENT_BYTES - 1) / 3),
      '"'.repeat(MAX_WORKTREE_CONTENT_BYTES - 1),
    ]) {
      expect(Buffer.byteLength(text)).toBe(MAX_WORKTREE_CONTENT_BYTES - 1);
      const input = { ...savedFile, content: { ...savedFile.content, text } };
      expect(worktreeFileRecordSchema.safeParse(input).success).toBe(true);
      expect(
        worktreeFileRecordSchema.safeParse({
          ...input,
          content: { ...input.content, text: `${text}x` },
        }).success
      ).toBe(false);
    }
  });

  it.each(['\n', '\r\n'])(
    'counts terminated and unterminated patch/source lines with %j',
    newline => {
      for (const [field, limit] of [
        ['patch', MAX_WORKTREE_PATCH_LINES],
        ['text', MAX_WORKTREE_CONTENT_LINES],
      ] as const) {
        const terminated = `x${newline}`.repeat(limit);
        for (const [text, valid] of [
          [terminated, true],
          [terminated.slice(0, -newline.length), true],
          [`${terminated}x`, false],
          [`${terminated}${newline}`, false],
        ] as const) {
          const input =
            field === 'patch'
              ? { ...savedFile, diff: { ...savedFile.diff, patch: text } }
              : { ...savedFile, content: { ...savedFile.content, text } };
          expect(worktreeFileRecordSchema.safeParse(input).success).toBe(valid);
        }
      }
    }
  );

  it('measures the entire encoded record including multibyte paths, escaping, and content', () => {
    const input = {
      ...savedFile,
      path: 'parent/ leading\tline\n"back\\slash-é-漢 ',
      diff: { ...savedFile.diff, patch: '漢"\\\t'.repeat(20_000) },
    };
    input.diff.patch += 'x'.repeat(
      MAX_WORKTREE_FILE_BYTES - Buffer.byteLength(JSON.stringify(input))
    );
    expect(Buffer.byteLength(JSON.stringify(input))).toBe(MAX_WORKTREE_FILE_BYTES);
    expect(JSON.stringify(input).length).toBeLessThan(MAX_WORKTREE_FILE_BYTES);
    expect(Buffer.byteLength(input.diff.patch)).toBeLessThan(MAX_WORKTREE_FILE_BYTES);
    expect(worktreeFileRecordSchema.parse(input)).toEqual(input);
    expect(
      worktreeFileRecordSchema.safeParse({
        ...input,
        content: { ...input.content, text: `${input.content.text}x` },
      }).success
    ).toBe(false);
  });

  it('requires exactly one same-revision record for every listed path, in any order', () => {
    const secondFile = { ...file, path: 'second.ts' };
    const secondRecord = { ...savedFile, path: secondFile.path };
    const input = { summary: capture([file, secondFile]), files: [secondRecord, savedFile] };
    expect(worktreeSnapshotCaptureSchema.parse(input)).toEqual(input);
    expect(worktreeSnapshotCaptureSchema.parse({ summary: capture([]), files: [] })).toEqual({
      summary: capture([]),
      files: [],
    });
    for (const invalid of [
      { ...input, files: [] },
      { ...input, files: [savedFile] },
      { ...input, files: [savedFile, savedFile] },
      { ...input, files: [savedFile, { ...secondRecord, path: 'extra.ts' }] },
      { ...input, files: [savedFile, secondRecord, { ...savedFile, path: 'extra.ts' }] },
      { ...input, files: [savedFile, { ...secondRecord, revision: savedFile.revision + 1 }] },
      { ...input, summary: capture([file, file]) },
      { ...input, summary: { ...input.summary, revision: savedFile.revision + 1 } },
      { ...input, extra: true },
    ]) {
      expect(worktreeSnapshotCaptureSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('requires deleted-original content only for deleted summary entries', () => {
    for (const status of ['added', 'modified', 'deleted'] as const) {
      const summary = capture([{ ...file, status }]);
      for (const source of ['current', 'deleted-original'] as const) {
        const input = {
          summary,
          files: [{ ...savedFile, content: { ...savedFile.content, source } }],
        };
        expect(worktreeSnapshotCaptureSchema.safeParse(input).success).toBe(
          source === (status === 'deleted' ? 'deleted-original' : 'current')
        );
      }
      expect(
        worktreeSnapshotCaptureSchema.safeParse({
          summary,
          files: [{ ...savedFile, content: { status: 'unavailable', reason: 'capture_failed' } }],
        }).success
      ).toBe(true);
    }
  });

  it('bounds the complete capture, including summary and omission metadata', () => {
    const files = Array.from({ length: 21 }, (_, index) => ({
      ...savedFile,
      path: `漢-${index}.ts`,
      diff: { ...savedFile.diff, patch: '"\\漢' },
      content: { status: 'unavailable', reason: 'budget_exhausted' },
    }));
    const input = { summary: capture(files.map(entry => ({ ...file, path: entry.path }))), files };
    let padding = MAX_WORKTREE_SNAPSHOT_BYTES - Buffer.byteLength(JSON.stringify(input));
    for (const entry of files) {
      const size = Math.min(
        padding,
        MAX_WORKTREE_FILE_BYTES - Buffer.byteLength(JSON.stringify(entry))
      );
      entry.diff.patch += 'x'.repeat(size);
      padding -= size;
    }
    expect(padding).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(input))).toBe(MAX_WORKTREE_SNAPSHOT_BYTES);
    expect(worktreeSnapshotCaptureSchema.safeParse(input).success).toBe(true);
    const oversized = {
      ...input,
      files: files.map((entry, index) =>
        index === files.length - 1
          ? { ...entry, diff: { ...entry.diff, patch: `${entry.diff.patch}x` } }
          : entry
      ),
    };
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBe(MAX_WORKTREE_SNAPSHOT_BYTES + 1);
    expect(worktreeSnapshotCaptureSchema.safeParse(oversized).success).toBe(false);
  });

  it('accepts only exact safe paths and positive expected revisions for saved queries', () => {
    const input = { path: 'parent/ leading\tline\n"back\\slash-é-漢 ', expectedRevision: 3 };
    expect(worktreeFileQuerySchema.parse(input)).toEqual(input);
    expect(
      worktreeFileQuerySchema.safeParse({
        path: file.path,
        expectedRevision: Number.MAX_SAFE_INTEGER,
      }).success
    ).toBe(true);
    for (const invalid of [
      {},
      { ...input, expectedRevision: 0 },
      { ...input, expectedRevision: 1.5 },
      { ...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, expectedRevision: '3' },
      { ...input, path: '../outside' },
      { ...input, path: '' },
      { ...input, directory: '/outside' },
      { ...input, baseRef: 'main' },
      { ...input, sessionId: 'other-session' },
    ]) {
      expect(worktreeFileQuerySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it('returns explicit saved-file states with matching diff status and validated metadata', () => {
    const available = {
      status: 'available',
      file: savedFile,
      capturedAt: snapshot.capturedAt,
      comparison: snapshot.comparison,
    };
    const omitted = {
      ...available,
      status: 'omitted',
      file: { ...savedFile, diff: { status: 'omitted', reason: 'binary' } },
    };
    for (const input of [
      available,
      omitted,
      { status: 'not_captured' },
      { status: 'no_longer_listed', currentRevision: 4 },
      { status: 'stale', currentRevision: 4 },
    ]) {
      expect(getWorktreeFileOutputSchema.parse(input)).toEqual(input);
    }
    for (const invalid of [
      { ...available, status: 'omitted' },
      { ...omitted, status: 'available' },
      { ...available, capturedAt: 'yesterday' },
      { ...available, comparison: { ...available.comparison, head: 'HEAD' } },
      { ...available, extra: true },
      { status: 'not_captured', file: savedFile },
      { status: 'no_longer_listed' },
      { status: 'no_longer_listed', currentRevision: 0 },
      { status: 'stale', currentRevision: Number.MAX_SAFE_INTEGER + 1 },
      { status: 'stale', currentRevision: 4, file: savedFile },
    ]) {
      expect(getWorktreeFileOutputSchema.safeParse(invalid).success).toBe(false);
    }
  });
});
