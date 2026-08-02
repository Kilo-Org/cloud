import { describe, expect, it } from 'vitest';

import { applyCodeReviewConfigPatch, type CodeReviewStoredConfig } from './config';

// Stored config snapshot covering every field the helper knows about, so each
// test can assert "this field is preserved" cleanly.
const stored: CodeReviewStoredConfig = {
  reviewStyle: 'balanced',
  focusAreas: ['bugs'],
  customInstructions: 'be terse',
  modelSlug: 'anthropic/claude-sonnet-5',
  thinkingEffort: null,
  gateThreshold: 'off',
  repositorySelectionMode: 'all',
  selectedRepositoryIds: [101, 202],
  repositoryModelOverrides: [
    {
      repositoryId: 101,
      repoFullName: 'acme/api',
      modelSlug: 'openai/gpt-5',
      thinkingEffort: 'high',
    },
  ],
  disableReviewMd: true,
  manuallyAddedRepositories: [{ id: 9, name: 'manual', full_name: 'manual/repo', private: true }],
  council: {
    enabled: true,
    aggregation_strategy: 'unanimous',
    specialists: [
      {
        id: 'security',
        role: 'security',
        name: 'Security',
        enabled: true,
        required: false,
        lens: 'audit',
      },
    ],
  },
  councilEnabledRepositoryIds: [101, 202],
};

describe('applyCodeReviewConfigPatch', () => {
  it('preserves every field of `stored` when the patch is empty', () => {
    const merged = applyCodeReviewConfigPatch(stored, {});
    expect(merged).toEqual(stored);
  });

  it('does not mutate `stored` or the patch', () => {
    const storedSnapshot = JSON.parse(JSON.stringify(stored));
    const patch = {
      reviewStyle: 'strict' as const,
      focusAreas: ['security'],
    };
    const patchSnapshot = JSON.parse(JSON.stringify(patch));
    applyCodeReviewConfigPatch(stored, patch);
    expect(stored).toEqual(storedSnapshot);
    expect(patch).toEqual(patchSnapshot);
  });

  it('preserves council / manuallyAddedRepositories / councilEnabledRepositoryIds when the mobile-style patch omits them', () => {
    // Mobile's PATCH only sends the mobile-shaped fields — council-related
    // fields must round-trip through untouched.
    const merged = applyCodeReviewConfigPatch(stored, {
      reviewStyle: 'strict',
      focusAreas: ['performance'],
      customInstructions: 'be nice',
      modelSlug: 'openai/gpt-5',
    });
    expect(merged.reviewStyle).toBe('strict');
    expect(merged.focusAreas).toEqual(['performance']);
    expect(merged.customInstructions).toBe('be nice');
    expect(merged.modelSlug).toBe('openai/gpt-5');
    expect(merged.council).toEqual(stored.council);
    expect(merged.manuallyAddedRepositories).toEqual(stored.manuallyAddedRepositories);
    expect(merged.councilEnabledRepositoryIds).toEqual(stored.councilEnabledRepositoryIds);
    // Unrelated stored fields stay put.
    expect(merged.thinkingEffort).toBe(stored.thinkingEffort);
    expect(merged.gateThreshold).toBe(stored.gateThreshold);
    expect(merged.repositorySelectionMode).toBe(stored.repositorySelectionMode);
    expect(merged.selectedRepositoryIds).toEqual(stored.selectedRepositoryIds);
  });

  it('updates only the keys present in the patch and leaves the rest alone', () => {
    const merged = applyCodeReviewConfigPatch(stored, {
      gateThreshold: 'critical',
      disableReviewMd: false,
    });
    expect(merged.gateThreshold).toBe('critical');
    expect(merged.disableReviewMd).toBe(false);
    expect(merged.reviewStyle).toBe(stored.reviewStyle);
    expect(merged.focusAreas).toEqual(stored.focusAreas);
    expect(merged.customInstructions).toBe(stored.customInstructions);
    expect(merged.modelSlug).toBe(stored.modelSlug);
    expect(merged.selectedRepositoryIds).toEqual(stored.selectedRepositoryIds);
    expect(merged.repositoryModelOverrides).toEqual(stored.repositoryModelOverrides);
    expect(merged.council).toEqual(stored.council);
    expect(merged.councilEnabledRepositoryIds).toEqual(stored.councilEnabledRepositoryIds);
  });

  it('replaces repositoryModelOverrides only when the patch supplies it (camelCase stays camelCase)', () => {
    const newOverrides = [
      {
        repositoryId: 303,
        repoFullName: 'acme/web',
        modelSlug: 'anthropic/claude-opus-4.8',
        thinkingEffort: null,
      },
    ];
    const merged = applyCodeReviewConfigPatch(stored, {
      repositoryModelOverrides: newOverrides,
    });
    // Same identity (shallow) — the helper doesn't clone complex values.
    expect(merged.repositoryModelOverrides).toBe(newOverrides);
    // No snake_case key leaks in: stored still uses `repositoryId`,
    // `repoFullName`, etc.
    expect(merged.repositoryModelOverrides?.[0]).toEqual({
      repositoryId: 303,
      repoFullName: 'acme/web',
      modelSlug: 'anthropic/claude-opus-4.8',
      thinkingEffort: null,
    });
    const firstOverride = (merged.repositoryModelOverrides ?? [])[0] as Record<string, unknown>;
    expect(firstOverride.repository_id).toBeUndefined();

    // And the omits case keeps the stored array intact.
    const untouched = applyCodeReviewConfigPatch(stored, { reviewStyle: 'lenient' });
    expect(untouched.repositoryModelOverrides).toBe(stored.repositoryModelOverrides);
  });

  it('treats a `null` patch value as an explicit clear (overrides stored), not an omit', () => {
    const merged = applyCodeReviewConfigPatch(stored, { council: null });
    expect(merged.council).toBeNull();
    // Other fields preserved.
    expect(merged.reviewStyle).toBe(stored.reviewStyle);
    expect(merged.councilEnabledRepositoryIds).toEqual(stored.councilEnabledRepositoryIds);
  });

  it('ignores explicit `undefined` values in the patch (preserves stored)', () => {
    const merged = applyCodeReviewConfigPatch(stored, {
      reviewStyle: undefined,
      // Cast to satisfy the partial type at the test call site.
      council: undefined,
    });
    expect(merged.reviewStyle).toBe(stored.reviewStyle);
    expect(merged.council).toEqual(stored.council);
  });

  it('updates council + councilEnabledRepositoryIds when the org patch supplies them', () => {
    const newCouncil = {
      enabled: true,
      aggregation_strategy: 'majority' as const,
      specialists: [
        {
          id: 'security',
          role: 'security',
          name: 'Security',
          enabled: true,
          required: false,
          lens: 'audit',
        },
        {
          id: 'perf',
          role: 'performance',
          name: 'Performance',
          enabled: true,
          required: false,
          lens: 'latency',
        },
      ],
    };
    const merged = applyCodeReviewConfigPatch(stored, {
      council: newCouncil,
      councilEnabledRepositoryIds: [303, 404],
    });
    expect(merged.council).toBe(newCouncil);
    expect(merged.councilEnabledRepositoryIds).toEqual([303, 404]);
    // Unrelated fields preserved.
    expect(merged.manuallyAddedRepositories).toEqual(stored.manuallyAddedRepositories);
    expect(merged.repositoryModelOverrides).toEqual(stored.repositoryModelOverrides);
  });
});
