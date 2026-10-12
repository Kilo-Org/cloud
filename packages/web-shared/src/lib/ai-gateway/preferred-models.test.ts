import { describe, expect, it } from '@jest/globals';
import { getConfiguredAutoFreeModels } from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import type * as AutoFreeConfigModule from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import {
  isKiloAutoModel,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FREE_MODEL,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import {
  buildMonitoredModels,
  buildPreferredModels,
} from '@kilocode/web-shared/lib/ai-gateway/models';
import { STEP_5_PREVIEW_FREE_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/stepfun';
import { getMonitoredModels, getPreferredModels } from './preferred-models';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config', () => ({
  ...jest.requireActual<typeof AutoFreeConfigModule>(
    '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config'
  ),
  getConfiguredAutoFreeModels: jest.fn(),
}));

describe('getPreferredModels', () => {
  it('places the StepFun free model above kilo-auto/free and configured auto-free models after it, excluding openrouter/free', async () => {
    jest.mocked(getConfiguredAutoFreeModels).mockResolvedValue([
      { model: 'provider/b:free', weight: 1, reasoning: { enabled: true } },
      { model: 'openrouter/free', weight: 1, reasoning: { enabled: true } },
      { model: 'provider/a:free', weight: 5, reasoning: { enabled: true } },
    ]);

    const preferredModels = await getPreferredModels();

    expect(preferredModels.slice(0, 5)).toEqual([
      KILO_AUTO_EFFICIENT_MODEL.id,
      STEP_5_PREVIEW_FREE_MODEL_ID,
      KILO_AUTO_FREE_MODEL.id,
      'provider/b:free',
      'provider/a:free',
    ]);
    expect(preferredModels).not.toContain('openrouter/free');
    expect(preferredModels).toEqual(buildPreferredModels(['provider/b:free', 'provider/a:free']));
    expect(await getMonitoredModels()).toEqual(
      buildMonitoredModels(['provider/b:free', 'provider/a:free'])
    );
    expect(await getMonitoredModels()).toEqual(
      preferredModels.filter(model => !isKiloAutoModel(model))
    );
  });

  it('has no free section when no auto-free config is stored', async () => {
    jest.mocked(getConfiguredAutoFreeModels).mockResolvedValue(null);

    expect(await getPreferredModels()).toEqual(buildPreferredModels([]));
  });
});
