import { describe, expect, it } from 'vitest';
import {
  KILO_MODEL_PREFIX,
  kiloGatewayModelIdCandidates,
  normalizeKiloModelId,
  unprefixKiloGatewayModelId,
} from './kilo-model-id.js';

describe('kilo model ids', () => {
  it('exposes the shared Kilo model prefix', () => {
    expect(KILO_MODEL_PREFIX).toBe('kilo/');
  });

  it('normalizes model ids to Kilo model ids', () => {
    expect(normalizeKiloModelId(undefined)).toBeUndefined();
    expect(normalizeKiloModelId(null)).toBeUndefined();
    expect(normalizeKiloModelId('')).toBeUndefined();
    expect(normalizeKiloModelId('   ')).toBeUndefined();
    expect(normalizeKiloModelId('openai/gpt-5.5')).toBe('kilo/openai/gpt-5.5');
    expect(normalizeKiloModelId('kilo/openai/gpt-5.5')).toBe('kilo/openai/gpt-5.5');
  });

  it('unprefixes gateway Kilo model ids only when the result remains provider-shaped', () => {
    expect(unprefixKiloGatewayModelId('openai/gpt-5.5')).toBeUndefined();
    expect(unprefixKiloGatewayModelId('kilo/openai/gpt-5.5')).toBe('openai/gpt-5.5');
    expect(unprefixKiloGatewayModelId('kilo/kilo/special-model')).toBe('kilo/special-model');
    expect(unprefixKiloGatewayModelId('kilo/special-model')).toBeUndefined();
  });

  it('orders exact model stats candidates before fallback candidates', () => {
    expect(kiloGatewayModelIdCandidates('openai/gpt-5.5')).toEqual(['openai/gpt-5.5']);
    expect(kiloGatewayModelIdCandidates('kilo/openai/gpt-5.5')).toEqual([
      'kilo/openai/gpt-5.5',
      'openai/gpt-5.5',
    ]);
    expect(kiloGatewayModelIdCandidates('kilo/kilo/special-model')).toEqual([
      'kilo/kilo/special-model',
      'kilo/special-model',
    ]);
    expect(kiloGatewayModelIdCandidates('kilo/special-model')).toEqual(['kilo/special-model']);
  });
});
