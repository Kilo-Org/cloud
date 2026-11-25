import { UTS_ENDPOINTS, UTS_SIGNER_COUNT } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import { signerObjectName, signerOfObjectId, signerOfObjectName } from '../../src/dos/stubs';
import type { UtsConfig } from '../../src/env';
import { signerForGrant } from '../../src/keys/signer-choice';

describe('signerForGrant', () => {
  it('picks the same signer for the same grant', async () => {
    expect(await signerForGrant('grant-a')).toBe(await signerForGrant('grant-a'));
  });

  it('spreads grants evenly over the 16 signers', async () => {
    const counts = Array.from({ length: UTS_SIGNER_COUNT }, () => 0);
    for (let index = 0; index < 16_000; index += 1) {
      const signer = await signerForGrant(`grant-${index}`);
      expect(signer).toBeGreaterThanOrEqual(0);
      expect(signer).toBeLessThan(UTS_SIGNER_COUNT);
      counts[signer] = (counts[signer] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
  });
});

describe('signer object names', () => {
  it('round-trips every signer index in its own environment only', () => {
    for (let signer = 0; signer < UTS_SIGNER_COUNT; signer += 1) {
      const name = signerObjectName('staging', signer);
      expect(signerOfObjectName('staging', name)).toBe(signer);
      expect(signerOfObjectName('production', name)).toBeNull();
    }
    expect(signerObjectName('production', 7)).toBe('production:signer:07');
  });

  it('rejects names outside the 16 signers', () => {
    expect(signerOfObjectName('production', 'production:signer:16')).toBeNull();
    expect(signerOfObjectName('production', 'production:feed:00')).toBeNull();
    expect(() => signerObjectName('production', 16)).toThrow();
  });
});

describe('signerOfObjectId', () => {
  const production: UtsConfig = {
    environment: 'production',
    endpoints: UTS_ENDPOINTS.production,
    jurisdiction: 'eu',
  };
  const development: UtsConfig = {
    environment: 'development',
    endpoints: UTS_ENDPOINTS.development,
    jurisdiction: 'none',
  };

  const refused = (reason: string) => ({ status: 'refused', reason });
  const NAME_REFUSAL = 'signer object was not created by its signer name';

  it('gives a signer name in its environment and jurisdiction its index', () => {
    expect(
      signerOfObjectId(production, { name: 'production:signer:09', jurisdiction: 'eu' })
    ).toEqual({
      status: 'signer',
      signer: 9,
    });
    expect(signerOfObjectId(development, { name: 'development:signer:00' })).toEqual({
      status: 'signer',
      signer: 0,
    });
  });

  it('refuses an object outside the eu jurisdiction in production, and a scoped one in development', () => {
    expect(signerOfObjectId(production, { name: 'production:signer:09' })).toEqual(
      refused('signer object is in jurisdiction none, not eu')
    );
    expect(
      signerOfObjectId(production, { name: 'production:signer:09', jurisdiction: 'fedramp' })
    ).toEqual(refused('signer object is in jurisdiction fedramp, not eu'));
    expect(
      signerOfObjectId(development, { name: 'development:signer:00', jurisdiction: 'eu' })
    ).toEqual(refused('signer object is in jurisdiction eu, not none'));
  });

  it('refuses an id without a name, or with another environment or object kind', () => {
    expect(signerOfObjectId(production, { jurisdiction: 'eu' })).toEqual(refused(NAME_REFUSAL));
    expect(signerOfObjectId(production, { name: 'staging:signer:01', jurisdiction: 'eu' })).toEqual(
      refused(NAME_REFUSAL)
    );
    expect(
      signerOfObjectId(production, { name: 'production:feed:00', jurisdiction: 'eu' })
    ).toEqual(refused(NAME_REFUSAL));
  });
});
