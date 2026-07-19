import { afterEach, describe, expect, it } from 'vitest';

import { isPushSinkEnabled, setPushSinkModeForTesting } from './push-sink';

describe('isPushSinkEnabled', () => {
  afterEach(() => {
    setPushSinkModeForTesting(undefined);
  });

  it('returns false when PUSH_SINK_MODE is unset (production wrangler.jsonc has no var)', () => {
    setPushSinkModeForTesting(undefined);
    expect(isPushSinkEnabled({})).toBe(false);
  });

  it('returns false when PUSH_SINK_MODE is an empty string (default in .dev.vars.example)', () => {
    setPushSinkModeForTesting(undefined);
    expect(isPushSinkEnabled({ PUSH_SINK_MODE: '' })).toBe(false);
  });

  it('returns false for any value other than the exact "log" sentinel', () => {
    setPushSinkModeForTesting(undefined);
    expect(isPushSinkEnabled({ PUSH_SINK_MODE: 'true' })).toBe(false);
    expect(isPushSinkEnabled({ PUSH_SINK_MODE: 'LOG' })).toBe(false);
    expect(isPushSinkEnabled({ PUSH_SINK_MODE: '1' })).toBe(false);
  });

  it('returns true only when PUSH_SINK_MODE is the exact "log" sentinel', () => {
    setPushSinkModeForTesting(undefined);
    expect(isPushSinkEnabled({ PUSH_SINK_MODE: 'log' })).toBe(true);
  });

  it('honors a test override even when env disagrees', () => {
    setPushSinkModeForTesting('log');
    expect(isPushSinkEnabled({ PUSH_SINK_MODE: undefined })).toBe(true);
    setPushSinkModeForTesting('off');
    expect(isPushSinkEnabled({ PUSH_SINK_MODE: 'log' })).toBe(false);
  });
});
