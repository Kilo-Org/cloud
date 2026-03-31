import { formatShortModelName, formatShortModelDisplayName } from './format-model-name';

describe('formatShortModelName', () => {
  it('strips provider prefix', () => {
    expect(formatShortModelName('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('strips kilo/ and provider prefix', () => {
    expect(formatShortModelName('kilo/anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('returns as-is when no slash present', () => {
    expect(formatShortModelName('claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  it('returns empty string as-is', () => {
    expect(formatShortModelName('')).toBe('');
  });

  it('handles model with multiple path segments after provider', () => {
    expect(formatShortModelName('google/gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });
});

describe('formatShortModelDisplayName', () => {
  it('strips "Provider: " prefix', () => {
    expect(formatShortModelDisplayName('Anthropic: Claude Opus 4.6')).toBe('Claude Opus 4.6');
  });

  it('strips Google prefix', () => {
    expect(formatShortModelDisplayName('Google: Gemini 2.5 Pro')).toBe('Gemini 2.5 Pro');
  });

  it('returns as-is when no colon-space present', () => {
    expect(formatShortModelDisplayName('GPT-4o')).toBe('GPT-4o');
  });

  it('returns empty string as-is', () => {
    expect(formatShortModelDisplayName('')).toBe('');
  });

  it('handles colon without space (not a provider prefix)', () => {
    expect(formatShortModelDisplayName('Model:v2')).toBe('Model:v2');
  });
});
