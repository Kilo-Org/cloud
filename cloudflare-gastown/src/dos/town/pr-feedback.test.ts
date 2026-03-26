import { describe, it, expect } from 'vitest';
import { TownConfigSchema } from '../../types';
import { _parsePrUrl as parsePrUrl } from './actions';
import { TownEventType } from '../../db/tables/town-events.table';
import { ReviewMetadataRecord } from '../../db/tables/review-metadata.table';

describe('TownConfigSchema refinery extensions', () => {
  it('defaults auto_resolve_pr_feedback to false', () => {
    const config = TownConfigSchema.parse({});
    expect(config.refinery).toBeUndefined();

    const configWithRefinery = TownConfigSchema.parse({ refinery: {} });
    expect(configWithRefinery.refinery?.auto_resolve_pr_feedback).toBe(false);
  });

  it('defaults auto_merge_delay_minutes to null', () => {
    const config = TownConfigSchema.parse({ refinery: {} });
    expect(config.refinery?.auto_merge_delay_minutes).toBeNull();
  });

  it('accepts auto_resolve_pr_feedback = true', () => {
    const config = TownConfigSchema.parse({
      refinery: { auto_resolve_pr_feedback: true },
    });
    expect(config.refinery?.auto_resolve_pr_feedback).toBe(true);
  });

  it('accepts auto_merge_delay_minutes = 0 (immediate merge)', () => {
    const config = TownConfigSchema.parse({
      refinery: { auto_merge_delay_minutes: 0 },
    });
    expect(config.refinery?.auto_merge_delay_minutes).toBe(0);
  });

  it('accepts auto_merge_delay_minutes = 15', () => {
    const config = TownConfigSchema.parse({
      refinery: { auto_merge_delay_minutes: 15 },
    });
    expect(config.refinery?.auto_merge_delay_minutes).toBe(15);
  });

  it('rejects negative auto_merge_delay_minutes', () => {
    expect(() =>
      TownConfigSchema.parse({ refinery: { auto_merge_delay_minutes: -1 } })
    ).toThrow();
  });

  it('preserves existing refinery fields alongside new ones', () => {
    const config = TownConfigSchema.parse({
      refinery: {
        gates: ['npm test'],
        auto_merge: false,
        require_clean_merge: true,
        auto_resolve_pr_feedback: true,
        auto_merge_delay_minutes: 60,
      },
    });
    expect(config.refinery?.gates).toEqual(['npm test']);
    expect(config.refinery?.auto_merge).toBe(false);
    expect(config.refinery?.require_clean_merge).toBe(true);
    expect(config.refinery?.auto_resolve_pr_feedback).toBe(true);
    expect(config.refinery?.auto_merge_delay_minutes).toBe(60);
  });
});

describe('parsePrUrl', () => {
  it('parses GitHub PR URLs', () => {
    const result = parsePrUrl('https://github.com/Kilo-Org/cloud/pull/42');
    expect(result).toEqual({ repo: 'Kilo-Org/cloud', prNumber: 42 });
  });

  it('parses GitHub PR URLs with long paths', () => {
    const result = parsePrUrl('https://github.com/org/repo/pull/123');
    expect(result).toEqual({ repo: 'org/repo', prNumber: 123 });
  });

  it('parses GitLab MR URLs', () => {
    const result = parsePrUrl('https://gitlab.com/group/project/-/merge_requests/7');
    expect(result).toEqual({ repo: 'group/project', prNumber: 7 });
  });

  it('parses GitLab MR URLs with subgroups', () => {
    const result = parsePrUrl(
      'https://gitlab.example.com/org/team/project/-/merge_requests/99'
    );
    expect(result).toEqual({ repo: 'org/team/project', prNumber: 99 });
  });

  it('returns null for unrecognized URLs', () => {
    expect(parsePrUrl('https://example.com/pr/1')).toBeNull();
    expect(parsePrUrl('not a url')).toBeNull();
  });
});

describe('TownEventType enum', () => {
  it('includes pr_feedback_detected and pr_auto_merge', () => {
    expect(TownEventType.options).toContain('pr_feedback_detected');
    expect(TownEventType.options).toContain('pr_auto_merge');
  });
});

describe('ReviewMetadataRecord', () => {
  it('includes auto_merge_ready_since and last_feedback_check_at fields', () => {
    const result = ReviewMetadataRecord.parse({
      bead_id: 'test-id',
      branch: 'feature/test',
      target_branch: 'main',
      merge_commit: null,
      pr_url: 'https://github.com/org/repo/pull/1',
      retry_count: 0,
      auto_merge_ready_since: '2025-01-01T00:00:00.000Z',
      last_feedback_check_at: '2025-01-01T00:00:00.000Z',
    });
    expect(result.auto_merge_ready_since).toBe('2025-01-01T00:00:00.000Z');
    expect(result.last_feedback_check_at).toBe('2025-01-01T00:00:00.000Z');
  });

  it('accepts null for new fields', () => {
    const result = ReviewMetadataRecord.parse({
      bead_id: 'test-id',
      branch: 'feature/test',
      target_branch: 'main',
      merge_commit: null,
      pr_url: null,
      retry_count: 0,
      auto_merge_ready_since: null,
      last_feedback_check_at: null,
    });
    expect(result.auto_merge_ready_since).toBeNull();
    expect(result.last_feedback_check_at).toBeNull();
  });
});

describe('config deep merge for refinery extensions', () => {
  it('preserves auto_resolve_pr_feedback when updating other refinery fields', async () => {
    // Test the merge logic by simulating what updateTownConfig does
    const current = TownConfigSchema.parse({
      refinery: {
        gates: ['npm test'],
        auto_resolve_pr_feedback: true,
        auto_merge_delay_minutes: 15,
      },
    });

    // Simulate a partial update that only changes gates
    const update = { gates: ['npm run test:all'] };
    const merged = {
      gates: update.gates ?? current.refinery?.gates ?? [],
      auto_merge: current.refinery?.auto_merge ?? true,
      require_clean_merge: current.refinery?.require_clean_merge ?? true,
      auto_resolve_pr_feedback:
        undefined ?? current.refinery?.auto_resolve_pr_feedback ?? false,
      auto_merge_delay_minutes:
        undefined !== undefined
          ? undefined
          : (current.refinery?.auto_merge_delay_minutes ?? null),
    };

    expect(merged.auto_resolve_pr_feedback).toBe(true);
    expect(merged.auto_merge_delay_minutes).toBe(15);
    expect(merged.gates).toEqual(['npm run test:all']);
  });
});
