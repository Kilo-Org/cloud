import { describe, expect, it } from '@jest/globals';
import { ENVIRONMENT_LIMITS } from '@kilocode/cloud-agent-profile';
import { profileVarKeyError } from './profile-var-key';

describe('profileVarKeyError', () => {
  it('accepts a key the profile write path stores', () => {
    expect(profileVarKeyError('API_KEY')).toBeNull();
    expect(profileVarKeyError('_private')).toBeNull();
    expect(profileVarKeyError('a'.repeat(ENVIRONMENT_LIMITS.MAX_KEY_LENGTH))).toBeNull();
  });

  it('refuses an empty key', () => {
    expect(profileVarKeyError('')).toMatch(/must not be empty/u);
  });

  it('refuses a key outside the key pattern or over the bound', () => {
    expect(profileVarKeyError('my-key')).toMatch(/must start with a letter or underscore/u);
    expect(profileVarKeyError('1TOKEN')).toMatch(/must start with a letter or underscore/u);
    expect(profileVarKeyError(' has space')).toMatch(/must start with a letter or underscore/u);
    expect(profileVarKeyError('a'.repeat(ENVIRONMENT_LIMITS.MAX_KEY_LENGTH + 1))).toMatch(
      /must start with a letter or underscore/u
    );
  });

  it('refuses a reserved name', () => {
    expect(profileVarKeyError('HOME')).toMatch(/is reserved/u);
    expect(profileVarKeyError('KILO_PROFILE')).toMatch(/is reserved/u);
  });
});
