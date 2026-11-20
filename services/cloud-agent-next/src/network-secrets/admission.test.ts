import { describe, expect, it } from 'vitest';
import { networkSecretFixture } from '../../test/helpers/network-secrets.js';
import { admitNetworkSecretCredential } from './admission.js';
import { prepareCredentialGrant } from '../sandbox-control/session-credentials.js';
import { buildFrameEnv } from '../control-plane/sandbox/frame-env.js';

describe('network secret admission', () => {
  it('checks the host before attempting decryption', async () => {
    const fixture = await networkSecretFixture();
    await expect(
      admitNetworkSecretCredential(
        fixture.alias,
        fixture.deps,
        undefined,
        [],
        'https://other.example.com/'
      )
    ).resolves.toEqual({ type: 'network-denied', key: 'SERVICE_TOKEN', reason: 'host_mismatch' });
    await expect(
      admitNetworkSecretCredential(
        fixture.alias,
        fixture.deps,
        undefined,
        [],
        'https://api.example.com/'
      )
    ).rejects.toThrow('encryption key unavailable');
  });
  it('keeps the managed GitHub alias separate from a GitHub Packages secret', async () => {
    const fixture = await networkSecretFixture();
    const secret = fixture.preparation.networkSecrets?.[0];
    if (!secret) throw new Error('Missing network secret fixture');
    secret.key = 'GITHUB_TOKEN';
    secret.allowedHosts = ['npm.pkg.github.com'];
    fixture.preparation.source.repository = { type: 'github', repo: 'synthetic/repository' };
    Object.assign(fixture.preparation.env, {
      GIT_TOKEN_SERVICE: {
        issueGitHubSessionCapability: async () => ({
          success: true,
          capability: 'kgh2.synthetic',
          source: 'installation',
          installationId: '123',
          appType: 'standard',
          gitAuthor: { name: 'Synthetic bot', email: 'bot@example.com' },
        }),
      },
    });
    const { grant, payload } = await prepareCredentialGrant(fixture.preparation);
    expect(payload.env?.GITHUB_TOKEN).toBe(secret.alias);
    expect(payload.env?.GH_TOKEN).toBe(grant.scm?.alias);
    expect(payload.env?.GH_TOKEN).not.toBe(secret.alias);
  });
  it('projects only an alias and decrypts only for an active bound grant', async () => {
    const fixture = await networkSecretFixture();
    expect(fixture.payload.env?.SERVICE_TOKEN).toBe(fixture.alias);
    expect(JSON.stringify(fixture.payload)).not.toContain(fixture.value);
    expect(JSON.stringify(fixture.grant)).not.toContain(fixture.value);
    expect(
      await admitNetworkSecretCredential(
        fixture.alias,
        fixture.deps,
        fixture.privateKeyPem,
        [],
        'https://api.example.com/'
      )
    ).toMatchObject({ type: 'network', key: 'SERVICE_TOKEN', value: fixture.value });
    const env = buildFrameEnv({
      specEnv: fixture.payload.env,
      encryptedSecrets: { SERVICE_TOKEN: fixture.snapshot.SERVICE_TOKEN.envelope },
      privateKey: fixture.privateKeyPem,
    });
    expect(env.env?.SERVICE_TOKEN).toBe(fixture.alias);
    expect(env.secretEnvKeys).not.toContain('SERVICE_TOKEN');
  });
  it.each([
    'expired',
    'foreign-owner',
    'foreign-container',
    'stopped',
    'released',
    'uncontained',
    'foreign-provider',
  ] as const)('rejects %s grants', async invalid => {
    const fixture = await networkSecretFixture();
    if (invalid === 'expired') fixture.grant.expiresAt = 0;
    if (invalid === 'foreign-owner') fixture.context.ownerId = 'another-owner';
    if (invalid === 'foreign-container') fixture.context.outboundContainerId = 'another-container';
    if (invalid === 'stopped') fixture.context.allocation.kind = 'stopped';
    if (invalid === 'released') fixture.context.liveSessionIds = [];
    if (invalid === 'uncontained') fixture.context.containmentEnabled = false;
    if (invalid === 'foreign-provider') fixture.context.provider = 'vercel';
    expect(
      await admitNetworkSecretCredential(
        fixture.alias,
        fixture.deps,
        fixture.privateKeyPem,
        [],
        'https://api.example.com/'
      )
    ).toBeNull();
  });
  it('rejects aliases bound to a different sandbox', async () => {
    const fixture = await networkSecretFixture();
    fixture.context.sandboxId = 'ses-other';
    expect(
      await admitNetworkSecretCredential(
        fixture.alias,
        fixture.deps,
        fixture.privateKeyPem,
        [],
        'https://api.example.com/'
      )
    ).toBeNull();
  });
  it('rejects provider fallback rather than projecting a real value', async () => {
    const fixture = await networkSecretFixture();
    await expect(
      prepareCredentialGrant({ ...fixture.preparation, provider: 'vercel' })
    ).rejects.toThrow('Network secrets require a Cloudflare sandbox');
  });
  it('rejects configured platform hosts before decryption', async () => {
    const fixture = await networkSecretFixture();
    await expect(
      admitNetworkSecretCredential(
        fixture.alias,
        fixture.deps,
        fixture.privateKeyPem,
        ['https://api.example.com'],
        'https://api.example.com/'
      )
    ).resolves.toEqual({ type: 'network-denied', key: 'SERVICE_TOKEN', reason: 'policy_denied' });
  });
});
