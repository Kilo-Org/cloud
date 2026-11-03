import { describe, expect, test } from '@jest/globals';
import {
  AUTO_SMALL_FREE_MODEL_UPSTREAM_ID,
  isAutoSmallFreeModel,
} from '@kilocode/web-shared/lib/ai-gateway/auto-small-free-model';
import { AUTO_SMALL_TARGET_MODELS } from '@kilocode/web-shared/lib/ai-gateway/auto-model';

const freeModelId = 'google/gemma-4-26b-a4b-it:free';
const paidModelId = 'google/gemma-4-26b-a4b-it';

describe('isAutoSmallFreeModel', () => {
  test('matches the free model kilo-auto/small routes to', () => {
    expect(AUTO_SMALL_TARGET_MODELS.free).toBe(freeModelId);
    expect(isAutoSmallFreeModel(freeModelId)).toBe(true);
  });

  test.each([paidModelId, 'google/gemma-4-31b-it:free', 'kilo-auto/small', 'openrouter/free'])(
    'does not match %s',
    modelId => {
      expect(isAutoSmallFreeModel(modelId)).toBe(false);
    }
  );
});

test('serves the auto small free model as the paid model kilo-auto/small targets', () => {
  expect(AUTO_SMALL_FREE_MODEL_UPSTREAM_ID).toBe(AUTO_SMALL_TARGET_MODELS.paid);
});
