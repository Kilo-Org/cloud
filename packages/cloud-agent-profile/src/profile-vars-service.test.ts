import { describe, test, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { MAX_PROFILE_VARS, profileVarColumns, setVar } from './profile-vars-service';
import { createLimitTestDb, TEST_PROFILE_ID } from './profile-limit-test-db';
import type { ProfileOwner } from './types';

const OWNER: ProfileOwner = { type: 'user', id: 'user_test' };
const PUBLIC_KEY = '';

const { publicKey: rsaPublicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_PUBLIC_KEY = Buffer.from(
  rsaPublicKey.export({ type: 'spki', format: 'pem' })
).toString('base64');

function storedKeys(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `VAR_${String(index)}`);
}

describe('setVar limits', () => {
  test('stores a new variable below the cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_VARS - 1, storedKeys(MAX_PROFILE_VARS - 1));

    await expect(
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'API_KEY', 'value', false, OWNER)
    ).resolves.toBeUndefined();

    expect(state.upserts).toBe(1);
    expect(state.rowCount).toBe(MAX_PROFILE_VARS);
    expect(state.lockCalls).toBe(1);
  });

  test('refuses a variable beyond the cap and writes nothing', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_VARS, storedKeys(MAX_PROFILE_VARS));

    await expect(
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'API_KEY', 'value', false, OWNER)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(state.upserts).toBe(0);
    expect(state.rowCount).toBe(MAX_PROFILE_VARS);
    expect(state.lockCalls).toBe(1);
  });

  test('sets a stored variable at the cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_VARS, [
      ...storedKeys(MAX_PROFILE_VARS - 1),
      'API_KEY',
    ]);

    await expect(
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'API_KEY', 'rotated', false, OWNER)
    ).resolves.toBeUndefined();

    expect(state.upserts).toBe(1);
    expect(state.rowCount).toBe(MAX_PROFILE_VARS);
    expect(state.lockCalls).toBe(1);
  });

  test('keeps concurrent writes within the cap', async () => {
    const { db, state } = createLimitTestDb(MAX_PROFILE_VARS - 1, storedKeys(MAX_PROFILE_VARS - 1));

    const results = await Promise.allSettled([
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'FIRST', 'a', false, OWNER),
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'SECOND', 'b', false, OWNER),
    ]);

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(state.rowCount).toBe(MAX_PROFILE_VARS);
    expect(state.lockCalls).toBe(2);
  });

  test('applies the key rules to a new key', async () => {
    const { db, state } = createLimitTestDb(0);

    await expect(
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'api key', 'value', false, OWNER)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(state.upserts).toBe(0);
    expect(state.lockCalls).toBe(1);
  });

  test('applies the reserved-name rule to a new key', async () => {
    const { db, state } = createLimitTestDb(0);

    await expect(
      setVar(db, PUBLIC_KEY, TEST_PROFILE_ID, 'KILO_PROFILE', 'value', false, OWNER)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(state.upserts).toBe(0);
    expect(state.lockCalls).toBe(1);
  });
});

describe('profileVarColumns', () => {
  test('stores a plain variable as env delivery with no policy', () => {
    expect(
      profileVarColumns(RSA_PUBLIC_KEY, { key: 'PLAIN_VAR', value: 'plain-value', isSecret: false })
    ).toEqual({
      key: 'PLAIN_VAR',
      value: 'plain-value',
      is_secret: false,
      delivery: 'env',
      allowed_hosts: null,
      injection_locations: null,
    });
  });

  test('encrypts a secret variable and keeps env delivery', () => {
    const columns = profileVarColumns(RSA_PUBLIC_KEY, {
      key: 'SECRET_VAR',
      value: 'the-plaintext',
      isSecret: true,
    });

    expect(columns).toMatchObject({
      key: 'SECRET_VAR',
      is_secret: true,
      delivery: 'env',
      allowed_hosts: null,
      injection_locations: null,
    });
    expect(columns.value).not.toBe('the-plaintext');
    expect(JSON.parse(columns.value)).toMatchObject({
      algorithm: 'rsa-aes-256-gcm',
      encryptedData: expect.any(String),
      encryptedDEK: expect.any(String),
    });
  });

  test('stores a policy-carrying variable as network delivery with its policy', () => {
    const columns = profileVarColumns(RSA_PUBLIC_KEY, {
      key: 'SERVICE_TOKEN',
      value: 'the-network-plaintext',
      isSecret: true,
      networkSecret: { allowedHosts: ['registry.example.com'], locations: ['header'] },
    });

    expect(columns).toMatchObject({
      key: 'SERVICE_TOKEN',
      is_secret: true,
      delivery: 'network',
      allowed_hosts: ['registry.example.com'],
      injection_locations: ['header'],
    });
    expect(columns.value).not.toBe('the-network-plaintext');
    // A network value carries its own envelope shape, not the env-secret one.
    expect(JSON.parse(columns.value)).toMatchObject({
      network: {
        algorithm: 'rsa-aes-256-gcm',
        encryptedData: expect.any(String),
        encryptedDEK: expect.any(String),
      },
    });
  });

  test('refuses a policy-carrying variable whose policy is invalid', () => {
    expect(() =>
      profileVarColumns(RSA_PUBLIC_KEY, {
        key: 'SERVICE_TOKEN',
        value: 'value',
        isSecret: true,
        networkSecret: { allowedHosts: [], locations: ['header'] },
      })
    ).toThrow();
  });
});
