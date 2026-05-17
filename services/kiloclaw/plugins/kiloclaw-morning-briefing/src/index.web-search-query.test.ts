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
  // Function now interpolates a single topic per call (per-topic loop
  // pattern). `collectWebSearch` short-circuits to a nudge when no
  // topics are selected and runs this builder once per remaining topic.

  it('interpolates a topic into the query string', () => {
    expect(buildBriefingWebSearchQuery('Tech')).toBe(
      'latest news and updates on Tech from the last 24 hours'
    );
  });

  it('interpolates a multi-word topic verbatim', () => {
    expect(buildBriefingWebSearchQuery('Health Tech')).toBe(
      'latest news and updates on Health Tech from the last 24 hours'
    );
  });

  it('does not trim — caller is responsible for sanitisation', () => {
    // The collectWebSearch caller trims + filters empty topics. This
    // function trusts the input so the same call site can build
    // arbitrary queries without re-trimming.
    expect(buildBriefingWebSearchQuery('  Markets ')).toBe(
      'latest news and updates on   Markets  from the last 24 hours'
    );
  });
});
