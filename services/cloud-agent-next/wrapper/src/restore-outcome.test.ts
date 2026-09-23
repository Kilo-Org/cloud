import { describe, it, expect } from 'bun:test';
import { buildRestoreIncompleteReport, buildRestoreIncompleteRules } from './restore-outcome';

describe('buildRestoreIncompleteReport', () => {
  it('returns undefined for a complete restore', () => {
    expect(
      buildRestoreIncompleteReport({
        applied: 3,
        skipped: 0,
        total: 3,
        skippedDiffs: [],
      })
    ).toBeUndefined();
  });

  it('names the count, the distinct reasons and the affected paths', () => {
    const report = buildRestoreIncompleteReport({
      applied: 7,
      skipped: 3,
      total: 10,
      skippedDiffs: [
        { file: 'a.ts', reason: 'patch_apply_failed' },
        { file: 'b.ts', reason: 'patch_apply_failed' },
        { file: 'c.ts', reason: 'missing_content' },
      ],
    });

    expect(report).toEqual({
      applied: 7,
      skipped: 3,
      total: 10,
      reasons: ['patch_apply_failed', 'missing_content'],
      paths: ['a.ts', 'b.ts', 'c.ts'],
      message:
        'Session restore incomplete: 3 of 10 files were not restored (the patch did not apply, the snapshot carried no content for the file). Missing: a.ts, b.ts, c.ts',
    });
  });

  it('keeps reasons and paths in first-seen order and de-duplicates them', () => {
    const report = buildRestoreIncompleteReport({
      applied: 0,
      skipped: 4,
      total: 4,
      skippedDiffs: [
        { file: 'b.ts', reason: 'unlink_failed' },
        { file: 'a.ts', reason: 'write_failed' },
        { file: 'b.ts', reason: 'unlink_failed' },
        { file: 'a.ts', reason: 'unlink_failed' },
      ],
    });

    expect(report?.reasons).toEqual(['unlink_failed', 'write_failed']);
    expect(report?.paths).toEqual(['b.ts', 'a.ts']);
  });

  it('names the reason unknown when the wrapper recorded no skip details', () => {
    const report = buildRestoreIncompleteReport({ applied: 1, skipped: 2, total: 3 });

    expect(report?.reasons).toEqual(['unknown']);
    expect(report?.paths).toEqual([]);
    expect(report?.message).toBe(
      'Session restore incomplete: 2 of 3 files were not restored (unknown).'
    );
  });

  it('passes an unrecognised reason through verbatim', () => {
    const report = buildRestoreIncompleteReport({
      applied: 0,
      skipped: 1,
      total: 1,
      skippedDiffs: [{ file: 'a.ts', reason: 'custom_reason' }],
    });

    expect(report?.reasons).toEqual(['custom_reason']);
    expect(report?.message).toContain('(custom_reason)');
  });

  it('caps the listed paths and summarises the remainder', () => {
    const skippedDiffs = Array.from({ length: 60 }, (_, index) => ({
      file: `src/file-${index}.ts`,
      reason: 'patch_apply_failed',
    }));
    const report = buildRestoreIncompleteReport({
      applied: 0,
      skipped: 60,
      total: 60,
      skippedDiffs,
    });

    expect(report?.paths).toHaveLength(50);
    expect(report?.paths[0]).toBe('src/file-0.ts');
    expect(report?.paths[49]).toBe('src/file-49.ts');
    expect(report?.message).toContain('Missing: src/file-0.ts');
    expect(report?.message.endsWith('and 10 more')).toBe(true);
  });
});

describe('buildRestoreIncompleteRules', () => {
  it('names the count, the reason word and each affected path', () => {
    const report = buildRestoreIncompleteReport({
      applied: 3,
      skipped: 2,
      total: 5,
      skippedDiffs: [
        { file: 'src/a.ts', reason: 'patch_apply_failed' },
        { file: 'src/b.ts', reason: 'patch_apply_failed' },
      ],
    });
    if (!report) throw new Error('expected an incomplete report');

    const rules = buildRestoreIncompleteRules(report);

    expect(rules).toContain('2 of 5 files could not be restored');
    expect(rules).toContain('the patch did not apply');
    expect(rules).toContain('- src/a.ts');
    expect(rules).toContain('- src/b.ts');
    expect(rules).toContain('Do not assume these paths are present');
  });
});
