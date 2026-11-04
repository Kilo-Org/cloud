import { describe, expect, test } from '@jest/globals';
import { formatRequestLogProvider } from './provider-label';

describe('formatRequestLogProvider', () => {
  test.each<string | null>([null, '', '   '])(
    'returns null when the inference provider is %p',
    inferenceProvider => {
      expect(formatRequestLogProvider('openrouter', inferenceProvider)).toBeNull();
      expect(formatRequestLogProvider(null, inferenceProvider)).toBeNull();
    }
  );

  test('prefixes an OpenRouter-routed inference provider with its gateway', () => {
    expect(formatRequestLogProvider('openrouter', 'deepinfra')).toBe('OpenRouter -> DeepInfra');
  });

  test('prefixes a Vercel-routed inference provider with its gateway', () => {
    expect(formatRequestLogProvider('vercel', 'bedrock')).toBe(
      'Vercel AI Gateway -> Amazon Bedrock'
    );
  });

  test.each<string | null>(['custom', null])(
    'omits the gateway prefix for provider %p',
    provider => {
      expect(formatRequestLogProvider(provider, 'novita')).toBe('Novita AI');
    }
  );

  test('resolves known inference providers case-insensitively', () => {
    expect(formatRequestLogProvider('openrouter', 'DEEPINFRA')).toBe('OpenRouter -> DeepInfra');
  });

  test('title-cases an unknown inference provider', () => {
    expect(formatRequestLogProvider('openrouter', '  acme labs  ')).toBe('OpenRouter -> Acme Labs');
    expect(formatRequestLogProvider(null, 'acme labs')).toBe('Acme Labs');
  });

  test('does not treat Object.prototype names as gateways', () => {
    expect(formatRequestLogProvider('constructor', 'deepinfra')).toBe('DeepInfra');
    expect(formatRequestLogProvider('hasOwnProperty', 'deepinfra')).toBe('DeepInfra');
  });

  test('does not treat Object.prototype names as inference providers', () => {
    expect(formatRequestLogProvider('vercel', 'constructor')).toBe(
      'Vercel AI Gateway -> Constructor'
    );
  });
});
