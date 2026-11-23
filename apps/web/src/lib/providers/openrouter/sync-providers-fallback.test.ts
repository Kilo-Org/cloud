/**
 * A refused alias promotion leaves the stored targets in place, so the sync publishes a snapshot
 * rendered from the targets the database actually holds. These tests cover the three properties of
 * that path: it renders from the targets the promotion observed rather than an unordered later
 * read, it re-renders without repeating the provider fan-out, and the snapshot it stores passed the
 * same plausibility check as the prospective one.
 */
import { describe, expect, it, jest } from '@jest/globals';
import type { NormalizedOpenRouterResponse } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import type { LatestAliasTargets } from '@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  acquireAliasPromotion: jest.fn(),
  releaseAliasPromotion: jest.fn(),
}));

import { resolveSnapshot } from '@/lib/providers/openrouter/sync-providers';

const ALIAS = '~vendor/latest';
const NEW = 'vendor/new';

function snapshot(providerCount: number, modelCount: number, label = 'stored') {
  return {
    providers: Array.from({ length: providerCount }, (_, index) => ({
      name: `provider-${index}`,
      displayName: `Provider ${index}`,
      slug: `provider-${index}`,
      dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
      models: Array.from({ length: modelCount }, (_, modelIndex) => ({
        slug: `${label}/model-${modelIndex}`,
        name: `${label} model ${modelIndex}`,
      })),
    })),
    total_providers: providerCount,
    total_models: providerCount * modelCount,
    generated_at: '2026-01-01T00:00:00.000Z',
  } as NormalizedOpenRouterResponse;
}

const prospective = snapshot(12, 10, 'prospective');
const rendered = snapshot(12, 11, 'stored');

describe('resolveSnapshot', () => {
  it('keeps the prospective snapshot when the promotion committed', async () => {
    const render = jest.fn(async (_targets: LatestAliasTargets) => rendered);

    const result = await resolveSnapshot({
      prospective,
      promotion: {
        written: true,
        observed: 1,
        targets: [{ alias: ALIAS, target: NEW }],
      },
      render,
    });

    expect(result).toEqual({
      providers: prospective,
      aliasTargets: [{ alias: ALIAS, target: NEW }],
    });
    expect(render).not.toHaveBeenCalled();
  });

  it('renders the targets the refused promotion observed, once', async () => {
    const render = jest.fn(async (_targets: LatestAliasTargets) => rendered);

    // The promotion read the winning targets under the lock. Rendering them is ordered against
    // that write by the same lock, so no unordered later read is needed.
    const result = await resolveSnapshot({
      prospective,
      promotion: {
        written: false,
        observed: 0,
        targets: [{ alias: ALIAS, target: NEW }],
      },
      render,
    });

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith(new Map([[ALIAS, { alias: ALIAS, target: NEW }]]));
    expect(result).toEqual({ providers: rendered, aliasTargets: [{ alias: ALIAS, target: NEW }] });
  });

  it('refuses an implausible snapshot rendered for a refused promotion', async () => {
    await expect(
      resolveSnapshot({
        prospective,
        promotion: { written: false, observed: 0, targets: [{ alias: ALIAS, target: NEW }] },
        render: async () => snapshot(9, 100),
      })
    ).rejects.toThrow('Suspicious: total number of providers is 9 < 10');

    await expect(
      resolveSnapshot({
        prospective,
        promotion: { written: false, observed: 0, targets: [{ alias: ALIAS, target: NEW }] },
        render: async () => snapshot(12, 8),
      })
    ).rejects.toThrow('Suspicious: total number of models is 96 < 100');
  });

  it('renders an empty target set when the promotion observed a reset', async () => {
    const render = jest.fn(async (_targets: LatestAliasTargets) => rendered);

    await resolveSnapshot({
      prospective,
      promotion: { written: false, observed: 0, targets: [] },
      render,
    });

    expect(render).toHaveBeenCalledWith(new Map());
  });
});
