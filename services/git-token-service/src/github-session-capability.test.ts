import { encryptWithSymmetricKey } from '@kilocode/encryption';
import { describe, expect, it, vi } from 'vitest';
import {
  GitHubSessionCapabilityCodec,
  GitHubSessionCapabilityError,
} from './github-session-capability.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const anotherEncryptionKey = Buffer.alloc(32, 8).toString('base64');
const claims = {
  userId: 'user_1',
  outboundContainerId: 'outbound-container-1',
  orgId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145b',
  integrationId: 'a65bf5a4-00f7-4a80-8841-4212d4fa9ede',
  owner: 'acme',
  repo: 'widgets',
  source: 'user',
  identity: {
    installationId: 'installation_1',
    accountLogin: 'acme',
    appType: 'standard',
    gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
    commitCoAuthor: {
      name: 'kiloconnect[bot]',
      email: '240665456+kiloconnect[bot]@users.noreply.github.com',
    },
  },
} as const;

describe('GitHubSessionCapabilityCodec', () => {
  it('rejects repository-only authority on a user-source capability', () => {
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);
    expect(() => codec.issue({ ...claims, permissionScope: 'repository' })).toThrow();
  });

  it('rejects issuance without a container binding', () => {
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);

    expect(() => codec.issue({ ...claims, outboundContainerId: '' })).toThrowError(
      expect.objectContaining({ reason: 'capability_configuration_error' })
    );
  });
  it('produces an opaque prefixed capability with time-bounded bound claims', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);

    const capability = codec.issue(claims);
    const decoded = codec.decode(capability);

    expect(capability).toMatch(/^kgh2\./);
    expect(capability).not.toContain('user_1');
    expect(capability).not.toContain('acme');
    expect(decoded).toEqual({
      purpose: 'github_scm_session',
      version: 2,
      userId: 'user_1',
      outboundContainerId: claims.outboundContainerId,
      orgId: claims.orgId,
      integrationId: claims.integrationId,
      owner: 'acme',
      repo: 'widgets',
      source: 'user',
      identity: claims.identity,
      issuedAt: Date.parse('2026-05-30T12:00:00.000Z'),
      expiresAt: Date.parse('2026-05-30T16:00:00.000Z'),
    });
    vi.useRealTimers();
  });

  it('rejects a legacy unbound capability', () => {
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);
    const issuedAt = Date.now();
    const legacyClaims = {
      purpose: 'github_scm_session',
      version: 1,
      userId: 'user_1',
      owner: 'acme',
      repo: 'widgets',
      source: 'installation',
      identity: claims.identity,
      issuedAt,
      expiresAt: issuedAt + 60_000,
    };
    const capability = `kgh1.${encryptWithSymmetricKey(JSON.stringify(legacyClaims), encryptionKey)}`;

    expect(() => codec.decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });

  it('continues decoding existing claims without an integration ID', () => {
    const { integrationId: _integrationId, ...existingClaims } = claims;
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);

    const decoded = codec.decode(codec.issue(existingClaims));

    expect(decoded).not.toHaveProperty('integrationId');
  });

  it('rejects an overlong container-bound capability', () => {
    const issuedAt = Date.now();
    const serializedClaims = JSON.stringify({
      purpose: 'github_scm_session',
      version: 2,
      ...claims,
      issuedAt,
      expiresAt: issuedAt + 4 * 60 * 60 * 1000 + 1,
    });
    const capability = `kgh2.${encryptWithSymmetricKey(serializedClaims, encryptionKey)}`;

    expect(() => new GitHubSessionCapabilityCodec(encryptionKey).decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });

  it('rejects expired and tampered capabilities', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);
    const capability = codec.issue(claims);

    vi.setSystemTime(new Date('2026-05-30T15:59:59.999Z'));
    expect(codec.decode(capability)).toMatchObject({ source: 'user' });

    vi.setSystemTime(new Date('2026-05-30T16:00:00.000Z'));
    expect(() => codec.decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'expired_capability' })
    );
    const changedOffset = capability.lastIndexOf('.') + 4;
    const changedCharacter = capability[changedOffset] === 'A' ? 'B' : 'A';
    const tampered = `${capability.slice(0, changedOffset)}${changedCharacter}${capability.slice(changedOffset + 1)}`;
    expect(() => codec.decode(tampered)).toThrowError(GitHubSessionCapabilityError);
    expect(() => codec.decode(`${capability}corrupted`)).toThrowError(GitHubSessionCapabilityError);
    vi.useRealTimers();
  });

  it('does not decode a capability with a different valid encryption key', () => {
    const capability = new GitHubSessionCapabilityCodec(encryptionKey).issue(claims);

    expect(() =>
      new GitHubSessionCapabilityCodec(anotherEncryptionKey).decode(capability)
    ).toThrowError(expect.objectContaining({ reason: 'invalid_capability' }));
  });

  it('rejects decrypted claims with another purpose', () => {
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);
    const serializedClaims = JSON.stringify({
      purpose: 'another_use',
      version: 2,
      userId: 'user_1',
      outboundContainerId: claims.outboundContainerId,
      owner: 'acme',
      repo: 'widgets',
      source: 'installation',
      identity: {
        installationId: 'installation_1',
        accountLogin: 'acme',
        appType: 'standard',
        gitAuthor: {
          name: 'kiloconnect[bot]',
          email: '240665456+kiloconnect[bot]@users.noreply.github.com',
        },
      },
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const capability = `kgh2.${encryptWithSymmetricKey(serializedClaims, encryptionKey)}`;

    expect(() => codec.decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });
});
