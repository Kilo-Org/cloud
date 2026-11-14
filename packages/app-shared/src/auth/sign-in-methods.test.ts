import { describe, expect, it } from 'vitest';

import { SIGN_IN_METHOD_REFUSAL_CODES, signInMethodRefusalForCode } from './sign-in-methods';

describe('signInMethodRefusalForCode', () => {
  it('maps each wire code onto its refusal', () => {
    expect(signInMethodRefusalForCode(SIGN_IN_METHOD_REFUSAL_CODES.lastMethod)).toBe('lastMethod');
    expect(signInMethodRefusalForCode(SIGN_IN_METHOD_REFUSAL_CODES.notLinked)).toBe('notLinked');
  });

  it('answers null for a missing or unknown code', () => {
    expect(signInMethodRefusalForCode(undefined)).toBeNull();
    expect(signInMethodRefusalForCode('')).toBeNull();
    expect(signInMethodRefusalForCode('some_other_upstream_failure')).toBeNull();
  });

  it('never resolves an inherited object name as a refusal', () => {
    // A plain-object lookup would return `Object.prototype.constructor` here.
    expect(signInMethodRefusalForCode('constructor')).toBeNull();
    expect(signInMethodRefusalForCode('toString')).toBeNull();
    expect(signInMethodRefusalForCode('__proto__')).toBeNull();
  });
});
