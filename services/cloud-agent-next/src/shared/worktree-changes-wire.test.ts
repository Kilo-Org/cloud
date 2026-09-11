import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  MAX_WORKTREE_CHANGES_BYTES as PUBLIC_MAX_BYTES,
  MAX_WORKTREE_CHANGES_FILES as PUBLIC_MAX_FILES,
  MAX_WORKTREE_CONTENT_BYTES as PUBLIC_MAX_CONTENT_BYTES,
  MAX_WORKTREE_CONTENT_LINES as PUBLIC_MAX_CONTENT_LINES,
  MAX_WORKTREE_FILE_BYTES as PUBLIC_MAX_FILE_BYTES,
  MAX_WORKTREE_PATCH_LINES as PUBLIC_MAX_PATCH_LINES,
  MAX_WORKTREE_SNAPSHOT_BYTES as PUBLIC_MAX_SNAPSHOT_BYTES,
  WORKTREE_FILE_SCHEMA_VERSION as PUBLIC_FILE_SCHEMA_VERSION,
  worktreeChangesCaptureRequestSchema,
  worktreeChangesCaptureSchema,
  worktreeChangesFileSchema as publicFileSchema,
  worktreeFileOmissionReasonSchema as publicOmissionReasonSchema,
  worktreeFileRecordSchema as publicFileRecordSchema,
  worktreeSnapshotCaptureSchema as publicSnapshotCaptureSchema,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import {
  MAX_WORKTREE_CHANGES_BYTES,
  MAX_WORKTREE_CHANGES_FILES,
  MAX_WORKTREE_CONTENT_BYTES,
  MAX_WORKTREE_CONTENT_LINES,
  MAX_WORKTREE_FILE_BYTES,
  MAX_WORKTREE_PATCH_LINES,
  MAX_WORKTREE_SNAPSHOT_BYTES,
  WORKTREE_FILE_SCHEMA_VERSION,
  sessionGitSummaryPayloadSchema,
  sessionGitSummaryResultSchema,
  sessionGitSnapshotPayloadSchema,
  sessionGitSnapshotResultSchema,
  worktreeChangesFileSchema,
  worktreeFileOmissionReasonSchema,
  worktreeFileRecordSchema,
  worktreeSnapshotCaptureSchema,
  type SessionGitSummaryResult,
  type WorktreeChangesFile,
  type WorktreeFileRecord,
} from './worktree-changes-wire.js';

const file: WorktreeChangesFile = {
  path: 'src/example.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  tracked: true,
  binary: false,
  countsComplete: true,
};
const capture: SessionGitSummaryResult = {
  revision: 1,
  comparison: {
    baseRef: 'refs/remotes/origin/main',
    mergeBase: 'a'.repeat(40),
    head: 'b'.repeat(40),
  },
  files: [file],
  truncated: false,
};

const savedFile = {
  schemaVersion: WORKTREE_FILE_SCHEMA_VERSION,
  revision: capture.revision,
  path: file.path,
  diff: {
    status: 'available',
    patch: 'diff --git a/src/example.ts b/src/example.ts\nold mode 100644\nnew mode 100755\n',
  },
  content: { status: 'available', source: 'current', text: '' },
} satisfies WorktreeFileRecord;

const requestSchemas = [
  sessionGitSummaryPayloadSchema,
  sessionGitSnapshotPayloadSchema,
  worktreeChangesCaptureRequestSchema,
];
const fileSchemas = [worktreeChangesFileSchema, publicFileSchema];
const captureSchemas = [sessionGitSummaryResultSchema, worktreeChangesCaptureSchema];
const fileRecordSchemas = [worktreeFileRecordSchema, publicFileRecordSchema];
const snapshotCaptureSchemas = [sessionGitSnapshotResultSchema, publicSnapshotCaptureSchema];

describe('standalone worktree wire/public schema parity', () => {
  it('keeps input and output types identical to the public contracts', () => {
    expectTypeOf<z.input<typeof sessionGitSummaryPayloadSchema>>().toEqualTypeOf<
      z.input<typeof worktreeChangesCaptureRequestSchema>
    >();
    expectTypeOf<z.output<typeof sessionGitSummaryPayloadSchema>>().toEqualTypeOf<
      z.output<typeof worktreeChangesCaptureRequestSchema>
    >();
    expectTypeOf<z.input<typeof worktreeChangesFileSchema>>().toEqualTypeOf<
      z.input<typeof publicFileSchema>
    >();
    expectTypeOf<z.output<typeof worktreeChangesFileSchema>>().toEqualTypeOf<
      z.output<typeof publicFileSchema>
    >();
    expectTypeOf<z.input<typeof sessionGitSummaryResultSchema>>().toEqualTypeOf<
      z.input<typeof worktreeChangesCaptureSchema>
    >();
    expectTypeOf<z.output<typeof sessionGitSummaryResultSchema>>().toEqualTypeOf<
      z.output<typeof worktreeChangesCaptureSchema>
    >();
    expectTypeOf<z.input<typeof sessionGitSnapshotPayloadSchema>>().toEqualTypeOf<
      z.input<typeof worktreeChangesCaptureRequestSchema>
    >();
    expectTypeOf<z.output<typeof sessionGitSnapshotPayloadSchema>>().toEqualTypeOf<
      z.output<typeof worktreeChangesCaptureRequestSchema>
    >();
    expectTypeOf<z.input<typeof worktreeFileOmissionReasonSchema>>().toEqualTypeOf<
      z.input<typeof publicOmissionReasonSchema>
    >();
    expectTypeOf<z.output<typeof worktreeFileOmissionReasonSchema>>().toEqualTypeOf<
      z.output<typeof publicOmissionReasonSchema>
    >();
    expectTypeOf<z.input<typeof worktreeFileRecordSchema>>().toEqualTypeOf<
      z.input<typeof publicFileRecordSchema>
    >();
    expectTypeOf<z.output<typeof worktreeFileRecordSchema>>().toEqualTypeOf<
      z.output<typeof publicFileRecordSchema>
    >();
    expectTypeOf<z.input<typeof sessionGitSnapshotResultSchema>>().toEqualTypeOf<
      z.input<typeof publicSnapshotCaptureSchema>
    >();
    expectTypeOf<z.output<typeof sessionGitSnapshotResultSchema>>().toEqualTypeOf<
      z.output<typeof publicSnapshotCaptureSchema>
    >();
  });

  it('keeps snapshot request/result aliases and capture budgets aligned', () => {
    expect(sessionGitSnapshotPayloadSchema).toBe(sessionGitSummaryPayloadSchema);
    expect(sessionGitSnapshotResultSchema).toBe(worktreeSnapshotCaptureSchema);
    expect(worktreeFileOmissionReasonSchema.options).toEqual(publicOmissionReasonSchema.options);
    for (const [wire, publicValue] of [
      [WORKTREE_FILE_SCHEMA_VERSION, PUBLIC_FILE_SCHEMA_VERSION],
      [MAX_WORKTREE_FILE_BYTES, PUBLIC_MAX_FILE_BYTES],
      [MAX_WORKTREE_SNAPSHOT_BYTES, PUBLIC_MAX_SNAPSHOT_BYTES],
      [MAX_WORKTREE_PATCH_LINES, PUBLIC_MAX_PATCH_LINES],
      [MAX_WORKTREE_CONTENT_BYTES, PUBLIC_MAX_CONTENT_BYTES],
      [MAX_WORKTREE_CONTENT_LINES, PUBLIC_MAX_CONTENT_LINES],
    ]) {
      expect(wire).toBe(publicValue);
    }
  });

  it('preserves requests at the revision and base-ref boundaries', () => {
    for (const input of [
      { revision: 1 },
      { revision: 2, baseRef: capture.comparison.baseRef },
      { revision: Number.MAX_SAFE_INTEGER, baseRef: 'x'.repeat(1024) },
    ]) {
      for (const schema of requestSchemas) expect(schema.parse(input)).toEqual(input);
    }
  });

  it('rejects invalid requests and routing fields in both contracts', () => {
    for (const input of [
      {},
      { revision: 0 },
      { revision: -1 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { revision: '1' },
      { revision: 1, baseRef: '' },
      { revision: 1, baseRef: null },
      { revision: 1, baseRef: 'x'.repeat(1025) },
      { revision: 1, baseRef: '--help' },
      { revision: 1, baseRef: 'main\0suffix' },
      { revision: 1, directory: '/outside' },
      { revision: 1, sessionId: 'other-session' },
    ]) {
      for (const schema of requestSchemas) expect(schema.safeParse(input).success).toBe(false);
    }
  });

  it('preserves file statuses, count flags, and unusual paths without normalization', () => {
    for (const input of [
      file,
      {
        ...file,
        status: 'added',
        tracked: false,
        additions: 0,
        deletions: 0,
        countsComplete: false,
      },
      {
        ...file,
        status: 'deleted',
        binary: true,
        additions: 0,
        deletions: 0,
        countsComplete: false,
      },
      { ...file, additions: Number.MAX_SAFE_INTEGER, deletions: Number.MAX_SAFE_INTEGER },
      { ...file, path: 'parent/ leading\tline\n"back\\slash-é-漢 ' },
      { ...file, path: 'x'.repeat(4096) },
    ]) {
      for (const schema of fileSchemas) expect(schema.parse(input)).toEqual(input);
    }
  });

  it('rejects unsafe or oversized paths in both contracts', () => {
    for (const path of [
      '',
      '/outside',
      '../outside',
      'parent/../outside',
      './file',
      'parent//file',
      'file\0suffix',
      'x'.repeat(4097),
    ]) {
      for (const schema of fileSchemas)
        expect(schema.safeParse({ ...file, path }).success).toBe(false);
    }
  });

  it('rejects invalid counts, missing flags, and file contents in both contracts', () => {
    for (const invalid of [
      { additions: -1 },
      { deletions: 1.5 },
      { additions: Number.MAX_SAFE_INTEGER + 1 },
      { deletions: Number.POSITIVE_INFINITY },
      { additions: Number.NaN },
      { tracked: 'true' },
      { binary: undefined },
      { countsComplete: undefined },
      { status: 'renamed' },
      { contents: 'not summary data' },
      { patch: 'not summary data' },
    ]) {
      for (const schema of fileSchemas)
        expect(schema.safeParse({ ...file, ...invalid }).success).toBe(false);
    }
  });

  it('preserves empty, truncated, and SHA-256 capture results', () => {
    for (const input of [
      capture,
      { ...capture, files: [] },
      { ...capture, truncated: true },
      {
        ...capture,
        revision: Number.MAX_SAFE_INTEGER,
        comparison: { baseRef: 'x'.repeat(1024), mergeBase: 'c'.repeat(64), head: 'd'.repeat(64) },
      },
    ]) {
      for (const schema of captureSchemas) expect(schema.parse(input)).toEqual(input);
    }
  });

  it('rejects invalid result envelopes and comparison identities in both contracts', () => {
    for (const invalid of [
      { revision: 0 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { files: null },
      { truncated: undefined },
      { capturedAt: '2026-08-27T00:00:00.000Z' },
      { schemaVersion: 1 },
      { comparison: { ...capture.comparison, baseRef: '--help' } },
      { comparison: { ...capture.comparison, baseRef: 'x'.repeat(1025) } },
      { comparison: { ...capture.comparison, head: 'HEAD' } },
      { comparison: { ...capture.comparison, mergeBase: 'a'.repeat(39) } },
      { comparison: { ...capture.comparison, head: 'B'.repeat(40) } },
      { comparison: { ...capture.comparison, directory: '/outside' } },
      { files: [{ ...file, contents: 'not summary data' }] },
      { files: [{ ...file, path: 'x'.repeat(4097) }] },
      { files: [{ ...file, additions: -1 }] },
    ]) {
      for (const schema of captureSchemas)
        expect(schema.safeParse({ ...capture, ...invalid }).success).toBe(false);
    }
  });

  it('enforces the same file-count boundary independently of serialized bytes', () => {
    expect(MAX_WORKTREE_CHANGES_FILES).toBe(PUBLIC_MAX_FILES);
    const input = {
      ...capture,
      files: Array.from({ length: PUBLIC_MAX_FILES }, (_, index) => ({
        ...file,
        path: String(index),
      })),
    };
    const oversized = { ...input, files: [...input.files, { ...file, path: 'extra' }] };
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(PUBLIC_MAX_BYTES);
    for (const schema of captureSchemas) {
      expect(schema.parse(input)).toEqual(input);
      expect(schema.safeParse(oversized).success).toBe(false);
    }
  });

  it('enforces the same inclusive UTF-8 byte limit, not JavaScript string length', () => {
    expect(MAX_WORKTREE_CHANGES_BYTES).toBe(PUBLIC_MAX_BYTES);
    const input = {
      ...capture,
      files: Array.from({ length: 80 }, (_, index) => ({
        ...file,
        path: `${index}/${'漢'.repeat(1000)}`,
      })),
    };
    let padding = PUBLIC_MAX_BYTES - Buffer.byteLength(JSON.stringify(input));
    expect(padding).toBeGreaterThan(0);
    for (const entry of input.files) {
      const length = Math.min(padding, 4096 - entry.path.length);
      entry.path += 'x'.repeat(length);
      padding -= length;
    }
    expect(padding).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(input))).toBe(PUBLIC_MAX_BYTES);
    expect(JSON.stringify(input).length).toBeLessThan(PUBLIC_MAX_BYTES);
    const oversized = {
      ...input,
      files: input.files.map((entry, index) =>
        index === input.files.length - 1 ? { ...entry, path: `${entry.path}x` } : entry
      ),
    };
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBe(PUBLIC_MAX_BYTES + 1);
    for (const schema of captureSchemas) {
      expect(schema.parse(input)).toEqual(input);
      expect(schema.safeParse(oversized).success).toBe(false);
    }
  });

  it('preserves complete, metadata-only, and omitted file records in both contracts', () => {
    const unusualPath = 'parent/ leading\tline\n"back\\slash-é-漢 ';
    for (const input of [
      savedFile,
      { ...savedFile, path: unusualPath, content: { ...savedFile.content, text: '漢"\\\n' } },
      { ...savedFile, content: { ...savedFile.content, source: 'deleted-original' } },
      ...worktreeFileOmissionReasonSchema.options.map(reason => ({
        ...savedFile,
        diff: { status: 'omitted', reason },
        content: { status: 'unavailable', reason },
      })),
    ]) {
      for (const schema of fileRecordSchemas) expect(schema.parse(input)).toEqual(input);
    }
  });

  it('rejects malformed or body-smuggling file records in both contracts', () => {
    for (const invalid of [
      { schemaVersion: 2 },
      { revision: 0 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { path: '../outside' },
      { path: '/outside' },
      { path: 'parent//file' },
      { path: 'file\0suffix' },
      { path: 'x'.repeat(4097) },
      { diff: { status: 'available', patch: '' } },
      { diff: { status: 'available', patch: 1 } },
      { diff: { status: 'omitted', reason: 'unknown' } },
      { diff: { status: 'omitted', reason: 'binary', patch: 'hidden' } },
      { content: { status: 'available', text: '' } },
      { content: { ...savedFile.content, source: 'base' } },
      { content: { ...savedFile.content, text: null } },
      { content: { status: 'unavailable', reason: 'unknown' } },
      { content: { status: 'unavailable', reason: 'binary', text: 'hidden' } },
      { extra: true },
    ]) {
      for (const schema of fileRecordSchemas) {
        expect(schema.safeParse({ ...savedFile, ...invalid }).success).toBe(false);
      }
    }
  });

  it('enforces the same inclusive encoded per-file limit with multibyte and escaped text', () => {
    const input = {
      ...savedFile,
      path: 'quote"\\漢.ts',
      diff: { ...savedFile.diff, patch: '漢"\\'.repeat(20_000) },
      content: { ...savedFile.content, text: '"'.repeat(MAX_WORKTREE_CONTENT_BYTES - 1) },
    };
    input.diff.patch += 'x'.repeat(
      MAX_WORKTREE_FILE_BYTES - Buffer.byteLength(JSON.stringify(input))
    );
    expect(Buffer.byteLength(JSON.stringify(input))).toBe(MAX_WORKTREE_FILE_BYTES);
    expect(JSON.stringify(input).length).toBeLessThan(MAX_WORKTREE_FILE_BYTES);
    const oversized = { ...input, diff: { ...input.diff, patch: `${input.diff.patch}x` } };
    for (const schema of fileRecordSchemas) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse(oversized).success).toBe(false);
    }
  });

  it('enforces matching raw UTF-8 content and rendering line boundaries', () => {
    const boundaryText = '漢'.repeat((MAX_WORKTREE_CONTENT_BYTES - 1) / 3);
    for (const schema of fileRecordSchemas) {
      for (const [text, valid] of [
        [boundaryText, true],
        [`${boundaryText}x`, false],
        ['x\n'.repeat(MAX_WORKTREE_CONTENT_LINES), true],
        ['x\n'.repeat(MAX_WORKTREE_CONTENT_LINES - 1) + 'x', true],
        ['x\n'.repeat(MAX_WORKTREE_CONTENT_LINES) + 'x', false],
      ] as const) {
        expect(
          schema.safeParse({ ...savedFile, content: { ...savedFile.content, text } }).success
        ).toBe(valid);
      }
      for (const [patch, valid] of [
        ['x\n'.repeat(MAX_WORKTREE_PATCH_LINES), true],
        ['x\n'.repeat(MAX_WORKTREE_PATCH_LINES - 1) + 'x', true],
        ['x\n'.repeat(MAX_WORKTREE_PATCH_LINES) + 'x', false],
      ] as const) {
        expect(schema.safeParse({ ...savedFile, diff: { ...savedFile.diff, patch } }).success).toBe(
          valid
        );
      }
    }
  });

  it('validates snapshot path/revision membership and deletion sources identically', () => {
    const secondFile = { ...file, path: 'deleted.md', status: 'deleted' };
    const secondRecord = {
      ...savedFile,
      path: secondFile.path,
      content: { ...savedFile.content, source: 'deleted-original' },
    };
    const input = {
      summary: { ...capture, files: [file, secondFile] },
      files: [secondRecord, savedFile],
    };
    for (const schema of snapshotCaptureSchemas) {
      expect(schema.parse(input)).toEqual(input);
      expect(
        schema.safeParse({ ...input, summary: { ...input.summary, truncated: true } }).success
      ).toBe(true);
      expect(schema.safeParse({ summary: { ...capture, files: [] }, files: [] }).success).toBe(
        true
      );
      for (const invalid of [
        { ...input, files: [] },
        { ...input, files: [savedFile] },
        { ...input, files: [savedFile, savedFile] },
        { ...input, files: [savedFile, { ...secondRecord, path: 'extra.md' }] },
        { ...input, files: [...input.files, { ...savedFile, path: 'extra.md' }] },
        { ...input, files: [savedFile, { ...secondRecord, revision: capture.revision + 1 }] },
        { ...input, files: [savedFile, { ...secondRecord, content: savedFile.content }] },
        { ...input, files: [{ ...savedFile, content: secondRecord.content }, secondRecord] },
        { ...input, summary: { ...capture, files: [file, file] } },
        { ...input, summary: { ...input.summary, patch: 'hidden' } },
        { ...input, summary: { ...capture, files: [{ ...file, content: 'hidden' }, secondFile] } },
        { ...input, extra: true },
      ]) {
        expect(schema.safeParse(invalid).success).toBe(false);
      }
    }
  });

  it('retains the same file-count cap for complete captures', () => {
    const files = Array.from({ length: MAX_WORKTREE_CHANGES_FILES }, (_, index) => ({
      ...savedFile,
      path: String(index),
    }));
    const summary = { ...capture, files: files.map(entry => ({ ...file, path: entry.path })) };
    for (const schema of snapshotCaptureSchemas) {
      expect(schema.safeParse({ summary, files }).success).toBe(true);
      expect(
        schema.safeParse({
          summary: { ...summary, files: [...summary.files, { ...file, path: 'extra' }] },
          files: [...files, { ...savedFile, path: 'extra' }],
        }).success
      ).toBe(false);
    }
  });

  it('enforces the same inclusive total capture budget on compact UTF-8 JSON', () => {
    const files = Array.from({ length: 21 }, (_, index) => ({
      ...savedFile,
      path: `漢-${index}.ts`,
      diff: { ...savedFile.diff, patch: '"\\漢' },
      content: { status: 'unavailable', reason: 'budget_exhausted' },
    }));
    const input = {
      summary: { ...capture, files: files.map(entry => ({ ...file, path: entry.path })) },
      files,
    };
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
    expect(JSON.stringify(input).length).toBeLessThan(MAX_WORKTREE_SNAPSHOT_BYTES);
    const oversized = {
      ...input,
      files: files.map((entry, index) =>
        index === files.length - 1
          ? { ...entry, diff: { ...entry.diff, patch: `${entry.diff.patch}x` } }
          : entry
      ),
    };
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBe(MAX_WORKTREE_SNAPSHOT_BYTES + 1);
    for (const schema of snapshotCaptureSchemas) {
      expect(schema.safeParse(input).success).toBe(true);
      expect(schema.safeParse(oversized).success).toBe(false);
    }
  });
});
