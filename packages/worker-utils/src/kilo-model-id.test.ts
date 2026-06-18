import { describe, expect, it } from 'vitest';
import {
  deriveModelStatsIdentity,
  KILO_MODEL_PREFIX,
  unprefixKiloGatewayModelId,
} from './kilo-model-id.js';

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

  it('derives model stats identity from provider-shaped model ids', () => {
    expect(deriveModelStatsIdentity('MoonshotAI/Kimi-K2.7-Code')).toEqual({
      slug: 'moonshotai-kimi-k2-7-code',
      modelCreator: 'MoonshotAI',
      creatorSlug: 'moonshotai',
    });
    expect(deriveModelStatsIdentity('special-model')).toEqual({
      slug: 'special-model',
      modelCreator: 'unknown',
      creatorSlug: 'unknown',
    });
  });
});
