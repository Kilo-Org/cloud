import type { ManualCodeReviewConfig } from '@kilocode/db/schema-types';

import { getManualCodeReviewConfig, parseManualCodeReviewConfig } from './manual-config';

const validConfig: ManualCodeReviewConfig = {
  agentConfig: {
    review_style: 'balanced',
    focus_areas: [],
    model_slug: 'anthropic/claude-sonnet-4.6',
  },
  instructions: null,
  outputMode: 'provider',
};

describe('parseManualCodeReviewConfig tolerance', () => {
  it('parses a valid manual config', () => {
    expect(parseManualCodeReviewConfig(validConfig)).toEqual(validConfig);
  });

  it('returns null for null/undefined without throwing', () => {
    expect(parseManualCodeReviewConfig(null)).toBeNull();
    expect(parseManualCodeReviewConfig(undefined)).toBeNull();
  });

  it('returns null instead of throwing for a legacy row missing agentConfig', () => {
    // The strict ManualCodeReviewConfigSchema documents this malformed shape;
    // stored rows predate the schema and must not throw into callers.
    expect(() =>
      parseManualCodeReviewConfig({ outputMode: 'kilo', instructions: null })
    ).not.toThrow();
    expect(parseManualCodeReviewConfig({ outputMode: 'kilo', instructions: null })).toBeNull();
  });

  it('returns null instead of throwing for a row carrying keys the strict schema rejects', () => {
    const legacy = { ...validConfig, legacyField: true };
    expect(() => parseManualCodeReviewConfig(legacy)).not.toThrow();
    expect(parseManualCodeReviewConfig(legacy)).toBeNull();
  });

  it('returns null for a non-object value', () => {
    expect(parseManualCodeReviewConfig('kilo')).toBeNull();
    expect(parseManualCodeReviewConfig(42)).toBeNull();
  });

  it('getManualCodeReviewConfig reads a valid stored row without throwing', () => {
    expect(getManualCodeReviewConfig({ manual_config: validConfig })).toEqual(validConfig);
  });

  it('getManualCodeReviewConfig tolerates a malformed stored row', () => {
    expect(getManualCodeReviewConfig({ manual_config: { outputMode: 'provider' } })).toBeNull();
  });
});
