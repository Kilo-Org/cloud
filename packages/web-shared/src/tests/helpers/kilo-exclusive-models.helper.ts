import { afterAll, beforeAll } from '@jest/globals';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { MARTIAN } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/martian';
import type { KiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';

export const paidStealthModelFixture: KiloExclusiveModel = {
  public_id: 'stealth/paid-fixture',
  internal_id: 'vendor/paid-fixture:optimized',
  display_name: 'Stealth: Paid Fixture (20% off)',
  description: 'A paid stealth model used by tests.',
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  provider: MARTIAN,
  flags: ['reasoning', 'vision', 'requires-data-collection'],
  pricing: {
    tiers: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 4,
          completion_per_million: 20,
          input_cache_read_per_million: 0.4,
          input_cache_write_per_million: 5,
        },
      },
    ],
  },
  inference_providers: ['stealth'],
};

export const tieredStealthModelFixture: KiloExclusiveModel = {
  ...paidStealthModelFixture,
  public_id: 'stealth/tiered-fixture',
  internal_id: 'vendor/tiered-fixture',
  display_name: 'Stealth: Tiered Fixture (50% off)',
  max_completion_tokens: 65_536,
  pricing: {
    tiers: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 0.25,
          completion_per_million: 1.5,
          input_cache_read_per_million: 0.025,
          input_cache_write_per_million: 0.3125,
        },
      },
      {
        start_context_length: 256 * 1024,
        pricing: {
          prompt_per_million: 1,
          completion_per_million: 3,
          input_cache_read_per_million: 0.1,
          input_cache_write_per_million: 1.25,
        },
      },
    ],
  },
};

export function addKiloExclusiveModel(model: KiloExclusiveModel): () => void {
  kiloExclusiveModels.push(model);
  return () => {
    const index = kiloExclusiveModels.indexOf(model);
    if (index !== -1) kiloExclusiveModels.splice(index, 1);
  };
}

export function useKiloExclusiveModel(model: KiloExclusiveModel = paidStealthModelFixture): void {
  let remove: (() => void) | undefined;
  beforeAll(() => {
    remove = addKiloExclusiveModel(model);
  });
  afterAll(() => {
    remove?.();
  });
}
