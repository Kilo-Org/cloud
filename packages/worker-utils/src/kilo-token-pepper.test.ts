import { describe, expect, it } from 'vitest';
import { isKiloTokenPepperCurrent, isKiloUserCredentialPepperCurrent } from './kilo-token-pepper';

const iat = 1_800_000_000;

describe('isKiloUserCredentialPepperCurrent', () => {
  it('accepts a present claim that equals the account pepper', () => {
    expect(isKiloUserCredentialPepperCurrent({ apiTokenPepper: 'current' }, 'current')).toBe(true);
    expect(isKiloUserCredentialPepperCurrent({ apiTokenPepper: null }, null)).toBe(true);
  });

  it('rejects a present claim that differs from the account pepper', () => {
    expect(isKiloUserCredentialPepperCurrent({ apiTokenPepper: 'stale' }, 'current')).toBe(false);
    expect(isKiloUserCredentialPepperCurrent({ apiTokenPepper: null }, 'current')).toBe(false);
    expect(isKiloUserCredentialPepperCurrent({ apiTokenPepper: 'stale' }, null)).toBe(false);
  });

  it('rejects an absent claim for an account with or without a pepper', () => {
    expect(isKiloUserCredentialPepperCurrent({}, 'current')).toBe(false);
    expect(isKiloUserCredentialPepperCurrent({}, null)).toBe(false);
  });
});

describe('isKiloTokenPepperCurrent', () => {
  it('compares a present claim with the account pepper', () => {
    expect(isKiloTokenPepperCurrent({ apiTokenPepper: 'current' }, 'current')).toBe(true);
    expect(isKiloTokenPepperCurrent({ apiTokenPepper: 'stale' }, 'current')).toBe(false);
    expect(isKiloTokenPepperCurrent({ apiTokenPepper: null }, null)).toBe(true);
    expect(isKiloTokenPepperCurrent({ apiTokenPepper: null }, 'rotated')).toBe(false);
  });

  it('compares a present claim even on a short-lived internal assertion', () => {
    expect(
      isKiloTokenPepperCurrent(
        {
          apiTokenPepper: 'stale',
          tokenPurpose: 'internal-service',
          aud: 'cloud-agent-next',
          iat,
          exp: iat + 3600,
        },
        'current'
      )
    ).toBe(false);
  });

  it('accepts an absent claim on a short-lived audience-bound internal-service assertion', () => {
    const claims = { tokenPurpose: 'internal-service', aud: 'session-ingest', iat };
    expect(isKiloTokenPepperCurrent({ ...claims, exp: iat + 3600 }, 'current')).toBe(true);
    expect(isKiloTokenPepperCurrent({ ...claims, exp: iat + 300 }, null)).toBe(true);
    expect(
      isKiloTokenPepperCurrent({ ...claims, aud: ['session-ingest'], exp: iat + 300 }, 'current')
    ).toBe(true);
  });

  it('rejects an absent claim on an internal-service assertion without an audience', () => {
    expect(
      isKiloTokenPepperCurrent(
        { tokenPurpose: 'internal-service', iat, exp: iat + 300 },
        'current'
      )
    ).toBe(false);
    expect(
      isKiloTokenPepperCurrent(
        { tokenPurpose: 'internal-service', aud: '', iat, exp: iat + 300 },
        'current'
      )
    ).toBe(false);
    expect(
      isKiloTokenPepperCurrent(
        { tokenPurpose: 'internal-service', aud: [], iat, exp: iat + 300 },
        'current'
      )
    ).toBe(false);
  });

  it('accepts an absent claim on a short-lived legacy internal assertion', () => {
    expect(isKiloTokenPepperCurrent({ iat, exp: iat + 3600 }, 'current')).toBe(true);
    expect(
      isKiloTokenPepperCurrent(
        { aud: 'git-token-service:bitbucket-repositories', iat, exp: iat + 300 },
        'current'
      )
    ).toBe(true);
  });

  it('rejects an absent claim on a token that lives longer than one hour', () => {
    expect(isKiloTokenPepperCurrent({ iat, exp: iat + 3601 }, 'current')).toBe(false);
    expect(isKiloTokenPepperCurrent({ iat, exp: iat + 157_680_000 }, null)).toBe(false);
    expect(
      isKiloTokenPepperCurrent(
        { tokenPurpose: 'internal-service', aud: 'session-ingest', iat, exp: iat + 3601 },
        'current'
      )
    ).toBe(false);
  });

  it('rejects an absent claim when iat or exp is missing or not a positive lifetime', () => {
    expect(isKiloTokenPepperCurrent({ exp: iat + 300 }, 'current')).toBe(false);
    expect(isKiloTokenPepperCurrent({ iat }, 'current')).toBe(false);
    expect(isKiloTokenPepperCurrent({}, null)).toBe(false);
    expect(isKiloTokenPepperCurrent({ iat, exp: iat }, 'current')).toBe(false);
    expect(isKiloTokenPepperCurrent({ iat: '1', exp: iat + 300 }, 'current')).toBe(false);
  });

  it('rejects an absent claim on a token with any other purpose', () => {
    for (const tokenPurpose of ['human-api', 'device-access', 'delegated-workload', 'unknown']) {
      expect(
        isKiloTokenPepperCurrent({ tokenPurpose, aud: 'kilo-api', iat, exp: iat + 300 }, 'current')
      ).toBe(false);
    }
  });
});
