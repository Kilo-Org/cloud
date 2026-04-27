import { describe, it, expect } from 'vitest';
import { TownConfigSchema } from '../../types';
import { _parsePrUrl as parsePrUrl } from './actions';
import { TownEventType } from '../../db/tables/town-events.table';
import { ReviewMetadataRecord } from '../../db/tables/review-metadata.table';
import { buildRefinerySystemPrompt } from '../../prompts/refinery-system.prompt';

describe('TownConfigSchema refinery extensions', () => {
  it('defaults code_review to true', () => {
    const config = TownConfigSchema.parse({ refinery: {} });
    expect(config.refinery?.code_review).toBe(true);
  });

  it('accepts code_review = false', () => {
    const config = TownConfigSchema.parse({ refinery: { code_review: false } });
    expect(config.refinery?.code_review).toBe(false);
  });

  // Schema-level defaults are deliberately conservative — parsing an empty
  // object returns undefined/false/null for the keys whose "new town" values
  // moved into seedNewTownConfig(). This protects existing persisted configs
  // from silently flipping behavior when they're re-loaded after a deploy.
  it('does NOT inject refinery defaults when parsing an empty object', () => {
    const config = TownConfigSchema.parse({});
    expect(config.refinery).toBeUndefined();
  });

  it('defaults auto_resolve_pr_feedback to false when refinery: {} is supplied', () => {
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
    expect(() => TownConfigSchema.parse({ refinery: { auto_merge_delay_minutes: -1 } })).toThrow();
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
    const result = parsePrUrl('https://gitlab.example.com/org/team/project/-/merge_requests/99');
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
  it('preserves auto_resolve_pr_feedback when updating other refinery fields', () => {
    // Simulate the merge logic from config.ts updateTownConfig:
    // When a partial update provides only gates, the new refinery fields
    // should fall through to the current value.
    const current = TownConfigSchema.parse({
      refinery: {
        gates: ['npm test'],
        auto_resolve_pr_feedback: true,
        auto_merge_delay_minutes: 15,
      },
    });

    // Partial update only touches gates — other fields come from current
    const updateGates: string[] | undefined = ['npm run test:all'];
    const updateAutoResolve: boolean | undefined = undefined;
    const updateDelayMinutes: number | null | undefined = undefined;

    const merged = {
      gates: updateGates ?? current.refinery?.gates ?? [],
      auto_merge: current.refinery?.auto_merge ?? true,
      require_clean_merge: current.refinery?.require_clean_merge ?? true,
      auto_resolve_pr_feedback:
        updateAutoResolve ?? current.refinery?.auto_resolve_pr_feedback ?? false,
      auto_merge_delay_minutes:
        updateDelayMinutes !== undefined
          ? updateDelayMinutes
          : (current.refinery?.auto_merge_delay_minutes ?? null),
    };

    expect(merged.auto_resolve_pr_feedback).toBe(true);
    expect(merged.auto_merge_delay_minutes).toBe(15);
    expect(merged.gates).toEqual(['npm run test:all']);
  });
});

describe('buildRefinerySystemPrompt with existingPrUrl', () => {
  const baseParams = {
    identity: 'refinery-alpha',
    rigId: 'rig-1',
    townId: 'town-1',
    gates: ['pnpm test'],
    branch: 'gt/toast/abc123',
    targetBranch: 'main',
    polecatAgentId: 'polecat-1',
    mergeStrategy: 'pr' as const,
  };

  it('produces standard PR-creation prompt when no existingPrUrl', () => {
    const prompt = buildRefinerySystemPrompt(baseParams);
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('create a pull request');
    expect(prompt).not.toContain('Pull Request:');
  });

  it('produces PR-review prompt in rework mode (default) when existingPrUrl is set', () => {
    const prompt = buildRefinerySystemPrompt({
      ...baseParams,
      existingPrUrl: 'https://github.com/org/repo/pull/42',
    });
    expect(prompt).toContain('https://github.com/org/repo/pull/42');
    expect(prompt).toContain('gh pr diff');
    expect(prompt).toContain('gt_request_changes');
    expect(prompt).toContain('Do NOT merge the PR');
    expect(prompt).not.toContain('gh pr create');
    expect(prompt).toContain('Do NOT create a new PR');
  });

  it('produces PR-review prompt in comments mode when existingPrUrl is set', () => {
    const prompt = buildRefinerySystemPrompt({
      ...baseParams,
      existingPrUrl: 'https://github.com/org/repo/pull/42',
      reviewMode: 'comments',
    });
    expect(prompt).toContain('https://github.com/org/repo/pull/42');
    expect(prompt).toContain('gh pr diff');
    expect(prompt).toContain('gh api repos/');
    expect(prompt).toContain('gh pr comment');
    expect(prompt).toContain('Do NOT merge the PR');
    expect(prompt).not.toContain('gh pr create');
    expect(prompt).toContain('Do NOT use `gh pr review --approve`');
  });

  it('includes gates in PR-review prompt', () => {
    const prompt = buildRefinerySystemPrompt({
      ...baseParams,
      gates: ['pnpm test', 'pnpm lint'],
      existingPrUrl: 'https://github.com/org/repo/pull/42',
    });
    expect(prompt).toContain('pnpm test');
    expect(prompt).toContain('pnpm lint');
  });
});
