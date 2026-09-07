import { describe, expect, it } from 'vitest';
import {
  MAX_WORKTREE_CHANGES_BYTES,
  MAX_WORKTREE_CHANGES_FILES,
  getWorktreeChangesOutputSchema,
  refreshWorktreeChangesOutputSchema,
  worktreeChangesCaptureRequestSchema,
  worktreeChangesCaptureSchema,
  worktreeChangesFileSchema,
  worktreeChangesSnapshotSchema,
  type WorktreeChangesFile,
  type WorktreeChangesSnapshot,
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
