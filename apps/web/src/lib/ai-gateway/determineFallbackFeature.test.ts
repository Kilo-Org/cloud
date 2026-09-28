import { describe, expect, test } from '@jest/globals';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { determineFallbackFeature } from '@/lib/ai-gateway/determineFallbackFeature';

const request: GatewayRequest = {
  kind: 'chat_completions',
  body: {
    model: 'anthropic/claude-sonnet-4',
    messages: [],
  },
};

describe('determineFallbackFeature', () => {
  test('does not fall back for Kilo Code user agents', () => {
    expect(determineFallbackFeature(request, 'Kilo-Code/5.12.0')).toBe('');
  });

  test('falls back for other user agents', () => {
    expect(determineFallbackFeature(request, 'Other/1.0')).toBe('direct-gateway');
  });
});
