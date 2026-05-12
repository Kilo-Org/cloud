import { describe, expect, it, vi } from 'vitest';

// The same Typebox/plugin-entry mocks as index.lifecycle.test.ts so we
// can import the module without the controller SDK installed.
vi.mock('@sinclair/typebox', () => ({
  Type: {
    Object: (value: unknown) => value,
    Optional: (value: unknown) => value,
    String: (value: unknown) => value,
    Union: (value: unknown) => value,
    Literal: (value: unknown) => value,
  },
}));

vi.mock('openclaw/plugin-sdk/plugin-entry', () => ({
  definePluginEntry: (entry: unknown) => entry,
}));

import { buildBriefingWebSearchQuery } from './index';

describe('buildBriefingWebSearchQuery', () => {
  it('returns the hardcoded engineering query when topics are empty', () => {
    expect(buildBriefingWebSearchQuery([])).toBe(
      'top engineering updates and breaking software infrastructure news from the last 24 hours'
    );
  });

  it('returns the engineering query when all topics are whitespace-only', () => {
    expect(buildBriefingWebSearchQuery(['  ', '\t', ''])).toBe(
      'top engineering updates and breaking software infrastructure news from the last 24 hours'
    );
  });

  it('interpolates a single topic', () => {
    expect(buildBriefingWebSearchQuery(['Tech'])).toBe(
      'latest news and updates on Tech from the last 24 hours'
    );
  });

  it('joins multiple topics with commas', () => {
    expect(buildBriefingWebSearchQuery(['Tech', 'AI', 'Finance'])).toBe(
      'latest news and updates on Tech, AI, Finance from the last 24 hours'
    );
  });

  it('trims topics before interpolating', () => {
    expect(buildBriefingWebSearchQuery(['  Tech  ', 'AI '])).toBe(
      'latest news and updates on Tech, AI from the last 24 hours'
    );
  });

  it('skips whitespace-only topics in a mixed list', () => {
    expect(buildBriefingWebSearchQuery(['Tech', '   ', 'AI'])).toBe(
      'latest news and updates on Tech, AI from the last 24 hours'
    );
  });
});
