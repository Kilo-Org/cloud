import { describe, expect, test } from '@jest/globals';
import { formatRequestLogProvider } from './provider-label';

describe('formatRequestLogProvider', () => {
  test.each<string | null>([null, '', '   '])(
    'returns null when the inference provider is %p',
    inferenceProvider => {
      expect(formatRequestLogProvider(inferenceProvider)).toBeNull();
    }
  );

  test('returns the prettified inference provider without a gateway prefix', () => {
    expect(formatRequestLogProvider('deepinfra')).toBe('DeepInfra');
    expect(formatRequestLogProvider('bedrock')).toBe('Amazon Bedrock');
    expect(formatRequestLogProvider('novita')).toBe('Novita AI');
  });

  test('resolves known inference providers case-insensitively', () => {
    expect(formatRequestLogProvider('DEEPINFRA')).toBe('DeepInfra');
  });

  test('title-cases an unknown inference provider', () => {
    expect(formatRequestLogProvider('  acme labs  ')).toBe('Acme Labs');
  });

  test('does not treat Object.prototype names as known inference providers', () => {
    expect(formatRequestLogProvider('constructor')).toBe('Constructor');
  });
});
