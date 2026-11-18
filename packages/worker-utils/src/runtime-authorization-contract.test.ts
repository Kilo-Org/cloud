import { describe, expect, it } from 'vitest';
import { resolveRuntimeEnvironment } from './runtime-authorization-contract.js';

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
