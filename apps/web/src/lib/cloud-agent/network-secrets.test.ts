import { afterEach, describe, expect, test } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { cloud_agent_environment_vars } from '@kilocode/db/schema';
import {
  createEnvironment,
  updateEnvironment,
  getEnvironment,
  loadEnvironmentForSession,
  createProfile,
  getProfile,
  setVar,
  listVars,
  mergeProfileConfiguration,
} from '@kilocode/cloud-agent-profile';
import { z } from 'zod';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const legacyEnvironmentEnvelopeSchema = z.object({
  encryptedData: z.string(),
  encryptedDEK: z.string(),
  algorithm: z.literal('rsa-aes-256-gcm'),
  version: z.literal(1),
});
const encryptionKey = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString(
  'base64'
);
const secret = {
  key: 'SERVICE_TOKEN',
  value: 'synthetic-network-value',
  allowedHosts: ['api.example.com'],
  locations: ['header'] as ['header'],
};

afterEach(async () => cleanupDbForTest());

async function environmentFixture() {
  const user = await insertTestUser();
  const owner = { type: 'user' as const, id: user.id };
  const created = await db.transaction(tx =>
    createEnvironment(tx, encryptionKey, {
      owner,
      createdByUserId: user.id,
      name: 'Synthetic network environment',
      platform: 'github',
      repoFullName: 'synthetic/repository',
      networkSecrets: [secret],
    })
  );
  return { owner, id: created.id };
}

describe('network secret storage and configuration', () => {
  test('refuses a saved non-Cloudflare allocation without changing the secret', async () => {
    const { owner, id } = await environmentFixture();
    await expect(
      db.transaction(tx =>
        createEnvironment(tx, encryptionKey, {
          owner,
          createdByUserId: owner.id,
          name: 'Invalid Vercel network environment',
          platform: 'github',
          repoFullName: 'synthetic/other-repository',
          networkSecrets: [secret],
          sandboxAllocation: 'vercel-small',
        })
      )
    ).rejects.toThrow('Network secrets require a Cloudflare sandbox');
    await expect(
      db.transaction(tx =>
        updateEnvironment(tx, encryptionKey, {
          owner,
          environmentId: id,
          sandboxAllocation: 'vercel-small',
        })
      )
    ).rejects.toThrow('Network secrets require a Cloudflare sandbox');
    expect((await getEnvironment(db, id, owner)).networkSecrets).toHaveLength(1);
  });
  test('stores an envelope, returns only metadata, and keeps network values outside environment delivery', async () => {
    const { owner, id } = await environmentFixture();
    const [stored] = await db
      .select()
      .from(cloud_agent_environment_vars)
      .where(eq(cloud_agent_environment_vars.environment_id, id));
    expect(stored.delivery).toBe('network');
    expect(stored.is_secret).toBe(true);
    expect(stored.value).not.toContain(secret.value);
    expect(JSON.parse(stored.value)).toMatchObject({ network: { algorithm: 'rsa-aes-256-gcm' } });
    expect(() => legacyEnvironmentEnvelopeSchema.parse(JSON.parse(stored.value))).toThrow();
    const response = await getEnvironment(db, id, owner);
    expect(response.networkSecrets).toEqual([
      { key: secret.key, allowedHosts: secret.allowedHosts, locations: ['header'] },
    ]);
    expect(response.secretKeys).toEqual([]);
    expect(response.plainVars).toEqual([]);
    expect(JSON.stringify(response)).not.toContain(secret.value);
    expect(JSON.stringify(response)).not.toContain('encryptedData');
    const resolution = await loadEnvironmentForSession(db, {
      owner,
      repository: { platform: 'github', repoFullName: 'synthetic/repository' },
      environmentId: id,
    });
    if (resolution.status !== 'match') throw new Error('Expected environment');
    expect(resolution.environment.layer.encryptedSecrets).toEqual({});
    expect(resolution.environment.layer.envVars).toEqual({});
    expect(resolution.environment.layer.networkSecrets?.SERVICE_TOKEN.envelope).toMatchObject({
      algorithm: 'rsa-aes-256-gcm',
    });
  });
  test('preserves network secrets during ordinary edits and updates their revision on replacement or deletion', async () => {
    const { owner, id } = await environmentFixture();
    const before = await getEnvironment(db, id, owner);
    await db.transaction(tx =>
      updateEnvironment(tx, encryptionKey, {
        owner,
        environmentId: id,
        plainVars: { LOG_LEVEL: 'debug' },
      })
    );
    expect((await getEnvironment(db, id, owner)).networkSecrets).toHaveLength(1);
    await db.transaction(tx =>
      updateEnvironment(tx, encryptionKey, {
        owner,
        environmentId: id,
        networkSecrets: [{ ...secret, allowedHosts: ['other.example.com'] }],
      })
    );
    const replaced = await getEnvironment(db, id, owner);
    expect(replaced.configurationRevision).toBeGreaterThan(before.configurationRevision);
    expect(replaced.networkSecrets?.[0].allowedHosts).toEqual(['other.example.com']);
    await db.transaction(tx =>
      updateEnvironment(tx, encryptionKey, {
        owner,
        environmentId: id,
        networkSecrets: [{ key: secret.key, delete: true }],
      })
    );
    expect((await getEnvironment(db, id, owner)).networkSecrets).toEqual([]);
  });
  test('rejects key collisions without changing the stored network secret', async () => {
    const { owner, id } = await environmentFixture();
    await expect(
      db.transaction(tx =>
        updateEnvironment(tx, encryptionKey, {
          owner,
          environmentId: id,
          secrets: [{ key: secret.key, value: 'ordinary-value' }],
        })
      )
    ).rejects.toThrow('cannot be both');
    expect((await getEnvironment(db, id, owner)).networkSecrets).toHaveLength(1);
  });
  test('converts an environment key between secret delivery modes in single updates', async () => {
    const { owner, id } = await environmentFixture();
    const rows = () =>
      db
        .select()
        .from(cloud_agent_environment_vars)
        .where(eq(cloud_agent_environment_vars.environment_id, id));
    await db.transaction(tx =>
      updateEnvironment(tx, encryptionKey, {
        owner,
        environmentId: id,
        networkSecrets: [{ key: secret.key, delete: true }],
        secrets: [{ key: secret.key, value: 'synthetic-env-secret' }],
      })
    );
    const envRows = await rows();
    expect(envRows).toEqual([
      expect.objectContaining({
        key: secret.key,
        delivery: 'env',
        is_secret: true,
        allowed_hosts: null,
        injection_locations: null,
      }),
    ]);
    expect(legacyEnvironmentEnvelopeSchema.safeParse(JSON.parse(envRows[0].value)).success).toBe(
      true
    );
    await db.transaction(tx =>
      updateEnvironment(tx, encryptionKey, {
        owner,
        environmentId: id,
        secrets: [{ key: secret.key, delete: true }],
        networkSecrets: [secret],
        plainVars: {},
      })
    );
    const networkRows = await rows();
    expect(networkRows).toEqual([
      expect.objectContaining({
        key: secret.key,
        delivery: 'network',
        is_secret: true,
        allowed_hosts: secret.allowedHosts,
        injection_locations: secret.locations,
      }),
    ]);
    expect(JSON.parse(networkRows[0].value)).toMatchObject({
      network: { algorithm: 'rsa-aes-256-gcm' },
    });
  });
  test('masks profile values through both read APIs and refuses delivery-mode collisions', async () => {
    const { owner } = await environmentFixture();
    const profile = await createProfile(db, owner, owner.id, 'Synthetic profile');
    await setVar(db, encryptionKey, profile.id, secret.key, secret.value, true, owner, {
      allowedHosts: secret.allowedHosts,
      locations: ['header'],
    });
    for (const variables of [
      await listVars(db, profile.id, owner),
      (await getProfile(db, profile.id, owner)).vars,
    ]) {
      expect(variables[0]).toMatchObject({
        key: secret.key,
        value: '***',
        delivery: 'network',
        allowedHosts: secret.allowedHosts,
      });
      expect(JSON.stringify(variables)).not.toContain(secret.value);
    }
    await expect(
      setVar(db, encryptionKey, profile.id, secret.key, 'ordinary-value', false, owner)
    ).rejects.toThrow('cannot be both');
  });
  test('removes earlier representations when a later profile or inline layer overrides a key', async () => {
    const { owner, id } = await environmentFixture();
    const profile = await createProfile(db, owner, owner.id, 'Synthetic override profile');
    const resolution = await loadEnvironmentForSession(db, {
      owner,
      repository: { platform: 'github', repoFullName: 'synthetic/repository' },
      environmentId: id,
    });
    if (resolution.status !== 'match') throw new Error('Expected environment');
    await setVar(db, encryptionKey, profile.id, secret.key, 'ordinary-value', false, owner);
    const plainOverride = await mergeProfileConfiguration(db, {
      owner,
      profileId: profile.id,
      environment: resolution.environment.layer,
    });
    expect(plainOverride.envVars?.SERVICE_TOKEN).toBe('ordinary-value');
    expect(plainOverride.networkSecrets).toBeUndefined();
    const networkOverride = await mergeProfileConfiguration(db, {
      owner,
      environment: resolution.environment.layer,
    });
    expect(networkOverride.networkSecrets?.SERVICE_TOKEN).toBeDefined();
    const inlineOverride = await mergeProfileConfiguration(db, {
      owner,
      environment: resolution.environment.layer,
      envVars: { SERVICE_TOKEN: 'inline-value' },
    });
    expect(inlineOverride.envVars?.SERVICE_TOKEN).toBe('inline-value');
    expect(inlineOverride.networkSecrets).toBeUndefined();
  });
});
