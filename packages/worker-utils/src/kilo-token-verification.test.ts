import { describe, it, expect } from 'vitest';
import { assertKiloTokenIssuedAt } from './kilo-token-verification.js';

describe('assertKiloTokenIssuedAt', () => {
  it('rejects a missing iat', () => {
    expect(() => assertKiloTokenIssuedAt(undefined, 1_000)).toThrow(
      'Missing or invalid token issued-at'
    );
  });

  it('rejects an iat in the future', () => {
    expect(() => assertKiloTokenIssuedAt(1_001, 1_000)).toThrow('Token issued in the future');
  });

  it('accepts an iat in the past', () => {
    expect(() => assertKiloTokenIssuedAt(999, 1_000)).not.toThrow();
  });
});
