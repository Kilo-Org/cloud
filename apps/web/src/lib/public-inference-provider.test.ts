import { describe, expect, test } from '@jest/globals';
import { normalizePublicInferenceProvider } from './public-inference-provider';

describe('normalizePublicInferenceProvider', () => {
  test.each([
    ['  future provider  ', 'futureprovider', 'Future Provider'],
    ['future-provider', 'futureprovider', 'Future Provider'],
    ['future_provider', 'futureprovider', 'Future Provider'],
    ['future--__provider', 'futureprovider', 'Future Provider'],
    ['__FUTURE-PROVIDER--', 'futureprovider', 'Future Provider'],
    ['DEEPINFRA', 'deepinfra', 'DeepInfra'],
    ['amazon-bedrock', 'bedrock', 'Amazon Bedrock'],
    ['together_ai', 'together', 'Together AI'],
    ['meituan', 'meituan', 'Meituan LongCat'],
    ['boundless', 'boundless', 'Boundless'],
    ['particle', 'particle', 'Particle'],
    ['runinfra', 'runinfra', 'RunInfra'],
    ['runware', 'runware', 'Runware'],
  ])('normalizes %s without changing its provider key', (provider, key, name) => {
    expect(normalizePublicInferenceProvider(provider)).toEqual({ key, name });
  });
});
