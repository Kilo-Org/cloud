import { describe, expect, it } from 'vitest';
import { KILO_MODEL_PREFIX, unprefixKiloGatewayModelId } from './kilo-model-id.js';

describe('kilo model ids', () => {
  it('exposes the shared Kilo model prefix', () => {
    expect(KILO_MODEL_PREFIX).toBe('kilo/');
  });

  it('unprefixes gateway Kilo model ids only when the result remains provider-shaped', () => {
    expect(unprefixKiloGatewayModelId('openai/gpt-5.5')).toBeUndefined();
    expect(unprefixKiloGatewayModelId('kilo/openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(unprefixKiloGatewayModelId('kilo/kilo/special-model')).toBe('kilo/special-model');
    expect(unprefixKiloGatewayModelId('kilo/special-model')).toBeUndefined();
  });
});
