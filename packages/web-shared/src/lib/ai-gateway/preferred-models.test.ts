import { describe, expect, it } from '@jest/globals';
import { getConfiguredAutoFreeModels } from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import type * as AutoFreeConfigModule from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config';
import {
  isKiloAutoModel,
  KILO_AUTO_EFFICIENT_MODEL,
  KILO_AUTO_FREE_MODEL,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { PREFERRED_MODELS } from '@kilocode/web-shared/lib/ai-gateway/models';
import { MINIMAX_CURRENT_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/minimax';
import { STEP_5_PREVIEW_FREE_MODEL_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/stepfun';
import { getMonitoredModels } from './preferred-models';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config', () => ({
  ...jest.requireActual<typeof AutoFreeConfigModule>(
    '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-free-config'
  ),
  getConfiguredAutoFreeModels: jest.fn(),
}));

describe('PREFERRED_MODELS', () => {
  it('lists the auto models first, then StepFun and Glyph Cluster, without MiniMax', () => {
    expect(PREFERRED_MODELS.slice(0, 4)).toEqual([
      KILO_AUTO_EFFICIENT_MODEL.id,
      KILO_AUTO_FREE_MODEL.id,
      STEP_5_PREVIEW_FREE_MODEL_ID,
      'stealth/glyph-cluster',
    ]);
    expect(PREFERRED_MODELS).not.toContain(MINIMAX_CURRENT_MODEL_ID);
  });
});

describe('getMonitoredModels', () => {
  it('monitors the concrete preferred models and configured auto-free models, excluding openrouter/free', async () => {
    jest.mocked(getConfiguredAutoFreeModels).mockResolvedValue([
      { model: 'provider/b:free', weight: 1, reasoning: { enabled: true } },
      { model: 'openrouter/free', weight: 1, reasoning: { enabled: true } },
      { model: 'provider/a:free', weight: 5, reasoning: { enabled: true } },
    ]);

    expect(await getMonitoredModels()).toEqual([
      ...PREFERRED_MODELS.filter(model => !isKiloAutoModel(model)),
      'provider/b:free',
      'provider/a:free',
    ]);
    expect(PREFERRED_MODELS).not.toContain('provider/b:free');
    expect(PREFERRED_MODELS).not.toContain('provider/a:free');
  });

  it('monitors only the concrete preferred models when no auto-free config is stored', async () => {
    jest.mocked(getConfiguredAutoFreeModels).mockResolvedValue(null);

    expect(await getMonitoredModels()).toEqual(
      PREFERRED_MODELS.filter(model => !isKiloAutoModel(model))
    );
  });
});
