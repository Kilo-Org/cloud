import { describe, expect, it } from 'vitest';
import {
  isKiloClaimlessInternalAssertion,
  isKiloTokenPepperCurrent,
  isKiloUserCredentialPepperCurrent,
} from './kilo-token-pepper';

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
  it('rejects an absent claim issued more than a minute ahead', () => {
    expect(isKiloTokenPepperCurrent({ iat: iat + 61, exp: iat + 361 }, 'current', iat)).toBe(false);
    expect(
      isKiloTokenPepperCurrent(
        {
          tokenPurpose: 'internal-service',
          aud: 'session-ingest',
          iat: iat + 3000,
          exp: iat + 6600,
        },
        'current',
        iat
      )
    ).toBe(false);
    expect(isKiloTokenPepperCurrent({ iat: iat + 60, exp: iat + 360 }, 'current', iat)).toBe(true);
  });

  it('rejects an absent claim that stays valid for more than one hour from now', () => {
    expect(isKiloTokenPepperCurrent({ iat: iat + 60, exp: iat + 3660 }, 'current', iat)).toBe(
      false
    );
  });

  it('compares a present claim with the account pepper', () => {
    expect(isKiloTokenPepperCurrent({ apiTokenPepper: 'current' }, 'current', iat)).toBe(true);
    expect(isKiloTokenPepperCurrent({ apiTokenPepper: 'stale' }, 'current', iat)).toBe(false);
    expect(isKiloTokenPepperCurrent({ apiTokenPepper: null }, null, iat)).toBe(true);
    expect(isKiloTokenPepperCurrent({ apiTokenPepper: null }, 'rotated', iat)).toBe(false);
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
        'current',
        iat
      )
    ).toBe(false);
  });

  it('accepts an absent claim on a short-lived audience-bound internal-service assertion', () => {
    const claims = { tokenPurpose: 'internal-service', aud: 'session-ingest', iat };
    expect(isKiloTokenPepperCurrent({ ...claims, exp: iat + 3600 }, 'current', iat)).toBe(true);
    expect(isKiloTokenPepperCurrent({ ...claims, exp: iat + 300 }, null, iat)).toBe(true);
    expect(
      isKiloTokenPepperCurrent(
        { ...claims, aud: ['session-ingest'], exp: iat + 300 },
        'current',
        iat
      )
    ).toBe(true);
  });

  it('rejects an absent claim on an internal-service assertion without an audience', () => {
    expect(
      isKiloTokenPepperCurrent(
        { tokenPurpose: 'internal-service', iat, exp: iat + 300 },
        'current',
        iat
      )
    ).toBe(false);
    expect(
      isKiloTokenPepperCurrent(
        { tokenPurpose: 'internal-service', aud: '', iat, exp: iat + 300 },
        'current',
        iat
      )
    ).toBe(false);
    expect(
      isKiloTokenPepperCurrent(
        { tokenPurpose: 'internal-service', aud: [], iat, exp: iat + 300 },
        'current',
        iat
      )
    ).toBe(false);
  });

  it('accepts an absent claim on a short-lived legacy internal assertion', () => {
    expect(isKiloTokenPepperCurrent({ iat, exp: iat + 3600 }, 'current', iat)).toBe(true);
    expect(
      isKiloTokenPepperCurrent(
        { aud: 'git-token-service:bitbucket-repositories', iat, exp: iat + 300 },
        'current',
        iat
      )
    ).toBe(true);
  });

  it('rejects an absent claim on a token that lives longer than one hour', () => {
    expect(isKiloTokenPepperCurrent({ iat, exp: iat + 3601 }, 'current', iat)).toBe(false);
    expect(isKiloTokenPepperCurrent({ iat, exp: iat + 157_680_000 }, null, iat)).toBe(false);
    expect(
      isKiloTokenPepperCurrent(
        { tokenPurpose: 'internal-service', aud: 'session-ingest', iat, exp: iat + 3601 },
        'current',
        iat
      )
    ).toBe(false);
  });

  it('rejects an absent claim when iat or exp is missing or not a positive lifetime', () => {
    expect(isKiloTokenPepperCurrent({ exp: iat + 300 }, 'current', iat)).toBe(false);
    expect(isKiloTokenPepperCurrent({ iat }, 'current', iat)).toBe(false);
    expect(isKiloTokenPepperCurrent({}, null, iat)).toBe(false);
    expect(isKiloTokenPepperCurrent({ iat, exp: iat }, 'current', iat)).toBe(false);
    expect(isKiloTokenPepperCurrent({ iat: '1', exp: iat + 300 }, 'current', iat)).toBe(false);
  });

  it('rejects an absent claim on a token with any other purpose', () => {
    for (const tokenPurpose of ['human-api', 'device-access', 'delegated-workload', 'unknown']) {
      expect(
        isKiloTokenPepperCurrent(
          { tokenPurpose, aud: 'kilo-api', iat, exp: iat + 300 },
          'current',
          iat
        )
      ).toBe(false);
    }
  });
});

describe('isKiloClaimlessInternalAssertion', () => {
  const disconnect = 'git-token-service:github-user-authorizations:disconnect';
  const fiveMinutes = { maxLifetimeSeconds: 300, audience: disconnect };

  it('accepts a modern assertion for the required audience within the lifetime', () => {
    expect(
      isKiloClaimlessInternalAssertion(
        { tokenPurpose: 'internal-service', aud: disconnect, iat, exp: iat + 300 },
        fiveMinutes,
        iat
      )
    ).toBe(true);
  });

  it('accepts the temporary legacy shape without an audience or with the required one', () => {
    expect(isKiloClaimlessInternalAssertion({ iat, exp: iat + 300 }, fiveMinutes, iat)).toBe(true);
    expect(
      isKiloClaimlessInternalAssertion({ aud: disconnect, iat, exp: iat + 300 }, fiveMinutes, iat)
    ).toBe(true);
  });

  it('rejects a pepper claim, another purpose, another audience or a longer lifetime', () => {
    const base = { tokenPurpose: 'internal-service', aud: disconnect, iat, exp: iat + 300 };
    expect(
      isKiloClaimlessInternalAssertion({ ...base, apiTokenPepper: null }, fiveMinutes, iat)
    ).toBe(false);
    expect(
      isKiloClaimlessInternalAssertion({ ...base, tokenPurpose: 'human-api' }, fiveMinutes, iat)
    ).toBe(false);
    expect(
      isKiloClaimlessInternalAssertion({ ...base, aud: 'session-ingest' }, fiveMinutes, iat)
    ).toBe(false);
    expect(
      isKiloClaimlessInternalAssertion(
        { aud: 'session-ingest', iat, exp: iat + 300 },
        fiveMinutes,
        iat
      )
    ).toBe(false);
    expect(isKiloClaimlessInternalAssertion({ ...base, exp: iat + 301 }, fiveMinutes, iat)).toBe(
      false
    );
    expect(
      isKiloClaimlessInternalAssertion(
        { tokenPurpose: 'internal-service', iat, exp: iat + 300 },
        { maxLifetimeSeconds: 300 },
        iat
      )
    ).toBe(false);
  });
});
