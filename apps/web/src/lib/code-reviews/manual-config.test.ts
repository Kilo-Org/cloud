import {
  ManualCodeReviewConfigSchema,
  type ManualCodeReviewConfig,
} from '@kilocode/db/schema-types';
import { describe, expect, it } from '@jest/globals';

import { getManualCodeReviewConfig, getManualCodeReviewConfigForDetail } from './manual-config';

function validConfig(): ManualCodeReviewConfig {
  return {
    agentConfig: {
      review_style: 'balanced',
      focus_areas: [],
      model_slug: 'anthropic/claude-sonnet-4.6',
    },
    instructions: null,
    outputMode: 'kilo',
  };
}

// Legacy rows can carry a `manual_config` that fails the strict schema, for
// example one without `agentConfig` or with keys the schema no longer accepts.
function legacyConfig(): Record<string, unknown> {
  return { instructions: null, outputMode: 'provider', legacy_key: true };
}

describe('getManualCodeReviewConfig', () => {
  it('returns null for an absent config', () => {
    expect(getManualCodeReviewConfig({ manual_config: null })).toBeNull();
    expect(getManualCodeReviewConfig({ manual_config: undefined })).toBeNull();
  });

  it('returns the parsed config for a valid stored shape', () => {
    const config = validConfig();
    expect(getManualCodeReviewConfig({ manual_config: config })).toEqual(config);
  });

  it('throws on a malformed stored shape', () => {
    expect(() => getManualCodeReviewConfig({ manual_config: legacyConfig() })).toThrow();
  });
});

describe('getManualCodeReviewConfigForDetail', () => {
  it('returns the parsed config for a valid stored shape', () => {
    const config = validConfig();
    expect(getManualCodeReviewConfigForDetail({ manual_config: config })).toEqual(config);
  });

  it('returns null for an absent config', () => {
    expect(getManualCodeReviewConfigForDetail({ manual_config: null })).toBeNull();
  });

  it('returns null for a malformed stored shape instead of failing the load', () => {
    expect(getManualCodeReviewConfigForDetail({ manual_config: legacyConfig() })).toBeNull();
  });
});

describe('ManualCodeReviewConfigSchema', () => {
  it('rejects a config without agentConfig', () => {
    const result = ManualCodeReviewConfigSchema.safeParse(legacyConfig());
    expect(result.success).toBe(false);
  });
});
