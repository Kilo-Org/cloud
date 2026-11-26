import { describe, expect, it } from 'vitest';
import {
  isCombinedRuntimeTokenAudience,
  isRuntimeTokenAudience,
  resolveRuntimeEnvironment,
  resolveRuntimeTokenAudienceMode,
} from './runtime-authorization-contract.js';

describe('resolveRuntimeEnvironment', () => {
  it.each([
    [undefined, 'production'],
    ['', 'production'],
    ['production', 'production'],
    ['development', 'development'],
    ['staging', 'production'],
    ['Development', 'production'],
  ] as const)('resolves %s to %s', (value, expected) => {
    expect(resolveRuntimeEnvironment(value)).toBe(expected);
  });
});

describe('resolveRuntimeTokenAudienceMode', () => {
  it.each([
    [undefined, 'combined'],
    ['combined', 'combined'],
    ['per-destination', 'per-destination'],
  ] as const)('resolves %s to %s', (value, expected) => {
    expect(resolveRuntimeTokenAudienceMode(value)).toBe(expected);
  });

  it.each(['', 'Per-Destination', 'per_destination'])('refuses the mistyped value %j', value => {
    expect(() => resolveRuntimeTokenAudienceMode(value)).toThrow();
  });
});

describe('isRuntimeTokenAudience', () => {
  const combined = ['kilo-api', 'kilo-gateway', 'session-ingest'];

  it('accepts the destination itself or the exact combined claim', () => {
    expect(isRuntimeTokenAudience('kilo-gateway', 'kilo-gateway')).toBe(true);
    expect(isRuntimeTokenAudience(combined, 'kilo-gateway')).toBe(true);
    expect(isCombinedRuntimeTokenAudience(combined)).toBe(true);
  });

  it.each([
    ['another destination', 'kilo-api'],
    ['a one-entry array', ['kilo-gateway']],
    ['a subset', ['kilo-api', 'kilo-gateway']],
    ['a reordered claim', ['kilo-gateway', 'kilo-api', 'session-ingest']],
    ['an extra entry', [...combined, 'cloud-agent-next']],
    ['no audience', undefined],
  ])('refuses %s', (_label, aud) => {
    expect(isRuntimeTokenAudience(aud, 'kilo-gateway')).toBe(false);
  });

  it('treats only the exact combined claim as combined', () => {
    expect(isCombinedRuntimeTokenAudience('kilo-api')).toBe(false);
    expect(isCombinedRuntimeTokenAudience(['kilo-api', 'kilo-gateway'])).toBe(false);
  });
});
