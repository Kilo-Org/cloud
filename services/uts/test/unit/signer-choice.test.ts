import { UTS_ENDPOINTS, UTS_SIGNER_COUNT } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import {
  KEY_SET_SHARD_COUNT,
  keySetShardObjectName,
  keySetShardOfObjectId,
  keySetShardOfObjectName,
  signerObjectName,
  signerOfObjectId,
  signerOfObjectName,
} from '../../src/dos/stubs';
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
    secretsSource: 'worker',
    relyingParty: { rpId: 'app.kilo.ai', origins: ['https://uts.kiloapps.io'] },
    managerBaseUrl: null,
    loginRotation: { status: 'off' },
  };
  const development: UtsConfig = {
    environment: 'development',
    endpoints: UTS_ENDPOINTS.development,
    jurisdiction: 'none',
    secretsSource: 'worker',
    relyingParty: { rpId: 'localhost', origins: ['http://localhost:8800'] },
    managerBaseUrl: null,
    loginRotation: { status: 'off' },
  };

  const refused = (reason: string) => ({ status: 'refused', reason });
  const NAME_REFUSAL = 'signer object was not created by its signer name';

  it('gives a signer name in its environment and jurisdiction its index', () => {
    expect(
      signerOfObjectId(production, { name: 'production:signer:09', jurisdiction: 'eu' })
    ).toEqual({ status: 'accepted', index: 9 });
    expect(signerOfObjectId(development, { name: 'development:signer:00' })).toEqual({
      status: 'accepted',
      index: 0,
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

  it('gives a key-set shard name its index, and refuses the other names and jurisdictions', () => {
    for (let shard = 0; shard < KEY_SET_SHARD_COUNT; shard += 1) {
      const name = keySetShardObjectName('production', shard);
      expect(keySetShardOfObjectName('production', name)).toBe(shard);
      expect(keySetShardOfObjectName('staging', name)).toBeNull();
      expect(keySetShardOfObjectId(production, { name, jurisdiction: 'eu' })).toEqual({
        status: 'accepted',
        index: shard,
      });
    }
    expect(keySetShardObjectName('staging', 3)).toBe('staging:keyset:3');
    expect(() => keySetShardObjectName('production', KEY_SET_SHARD_COUNT)).toThrow();
    expect(keySetShardOfObjectName('production', 'production:keyset:8')).toBeNull();
    const shardRefusal = 'key-set shard object was not created by its key-set shard name';
    expect(
      keySetShardOfObjectId(production, { name: 'production:signer:03', jurisdiction: 'eu' })
    ).toEqual(refused(shardRefusal));
    expect(keySetShardOfObjectId(production, { name: 'production:keyset:3' })).toEqual(
      refused('key-set shard object is in jurisdiction none, not eu')
    );
    expect(
      signerOfObjectId(production, { name: 'production:keyset:3', jurisdiction: 'eu' })
    ).toEqual(refused(NAME_REFUSAL));
  });
});
