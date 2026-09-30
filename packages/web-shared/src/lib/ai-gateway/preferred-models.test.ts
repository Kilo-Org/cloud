import { describe, expect, it } from '@jest/globals';
import { getConfiguredAutoFreeModels } from '@/lib/ai-gateway/auto-model/auto-free-config';
import type * as AutoFreeConfigModule from '@/lib/ai-gateway/auto-model/auto-free-config';
import { KILO_AUTO_EFFICIENT_MODEL, KILO_AUTO_FREE_MODEL } from '@/lib/ai-gateway/auto-model';
import { buildPreferredModels } from '@/lib/ai-gateway/models';
import { getPreferredModels } from './preferred-models';

jest.mock('@/lib/ai-gateway/auto-model/auto-free-config', () => ({
  ...jest.requireActual<typeof AutoFreeConfigModule>(
    '@/lib/ai-gateway/auto-model/auto-free-config'
  ),
  getConfiguredAutoFreeModels: jest.fn(),
}));

describe('getPreferredModels', () => {
  it('places configured auto-free models after the auto models, excluding openrouter/free', async () => {
    jest.mocked(getConfiguredAutoFreeModels).mockResolvedValue([
      { model: 'provider/b:free', weight: 1, reasoning: { enabled: true } },
      { model: 'openrouter/free', weight: 1, reasoning: { enabled: true } },
      { model: 'provider/a:free', weight: 5, reasoning: { enabled: true } },
    ]);

    const preferredModels = await getPreferredModels();

    expect(preferredModels.slice(0, 4)).toEqual([
      KILO_AUTO_EFFICIENT_MODEL.id,
      KILO_AUTO_FREE_MODEL.id,
      'provider/b:free',
      'provider/a:free',
    ]);
    expect(preferredModels).not.toContain('openrouter/free');
    expect(preferredModels).toEqual(buildPreferredModels(['provider/b:free', 'provider/a:free']));
  });

  it('has no free section when no auto-free config is stored', async () => {
    jest.mocked(getConfiguredAutoFreeModels).mockResolvedValue(null);

    expect(await getPreferredModels()).toEqual(buildPreferredModels([]));
  });
});
