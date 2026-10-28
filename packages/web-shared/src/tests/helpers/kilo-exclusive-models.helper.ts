import { afterAll, beforeAll } from '@jest/globals';
import {
  kiloExclusiveModels,
  type KiloExclusiveModel,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';

export const kiloExclusiveModelFixture: KiloExclusiveModel = {
  public_id: 'kilo-exclusive/fixture',
  internal_id: 'vendor/fixture',
  display_name: 'Kilo Exclusive Fixture',
  description: 'A Kilo-exclusive model used by tests.',
  context_length: 1_000_000,
  max_completion_tokens: 128_000,
  vision: true,
};

export function addKiloExclusiveModel(model: KiloExclusiveModel): () => void {
  kiloExclusiveModels.push(model);
  return () => {
    const index = kiloExclusiveModels.indexOf(model);
    if (index !== -1) kiloExclusiveModels.splice(index, 1);
  };
}

export function useKiloExclusiveModel(model: KiloExclusiveModel = kiloExclusiveModelFixture): void {
  let remove: (() => void) | undefined;
  beforeAll(() => {
    remove = addKiloExclusiveModel(model);
  });
  afterAll(() => {
    remove?.();
  });
}
