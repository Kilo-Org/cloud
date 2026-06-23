import { describe, expect, it } from 'vitest';
import { generateOpenRouterDownstreamSafetyIdentifier } from './provider-safety-identifiers';

describe('generateOpenRouterDownstreamSafetyIdentifier', () => {
  it('generates the stable OpenRouter user hash', () => {
    expect(generateOpenRouterDownstreamSafetyIdentifier('test-user-123')).toBe(
      'N/lWg32WD5gmmEwHYC4eqB8HuQS/8PEwCANz3wlkr8U='
    );
  });
});
