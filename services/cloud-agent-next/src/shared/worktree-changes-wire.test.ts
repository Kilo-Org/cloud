import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import {
  MAX_WORKTREE_CHANGES_BYTES as PUBLIC_MAX_BYTES,
  MAX_WORKTREE_CHANGES_FILES as PUBLIC_MAX_FILES,
  worktreeChangesCaptureRequestSchema,
  worktreeChangesCaptureSchema,
  worktreeChangesFileSchema as publicFileSchema,
} from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import {
  MAX_WORKTREE_CHANGES_BYTES,
  MAX_WORKTREE_CHANGES_FILES,
  sessionGitSummaryPayloadSchema,
  sessionGitSummaryResultSchema,
  worktreeChangesFileSchema,
  type SessionGitSummaryResult,
  type WorktreeChangesFile,
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

const requestSchemas = [sessionGitSummaryPayloadSchema, worktreeChangesCaptureRequestSchema];
const fileSchemas = [worktreeChangesFileSchema, publicFileSchema];
const captureSchemas = [sessionGitSummaryResultSchema, worktreeChangesCaptureSchema];

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
});
