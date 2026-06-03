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
      owner: 'acme',
      repo: 'widgets',
      source: 'user',
      identity: claims.identity,
      issuedAt: Date.parse('2026-05-30T12:00:00.000Z'),
      expiresAt: Date.parse('2026-05-30T16:00:00.000Z'),
    });
    vi.useRealTimers();
  });

  it('produces and decodes a two-hour legacy unbound v1 capability when the container is omitted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);
    const { outboundContainerId: _outboundContainerId, ...legacyClaims } = claims;

    const capability = codec.issue(legacyClaims);

    expect(capability).toMatch(/^kgh1\./);
    expect(codec.decode(capability)).toMatchObject({
      version: 1,
      userId: 'user_1',
      owner: 'acme',
      repo: 'widgets',
      issuedAt: Date.parse('2026-05-30T12:00:00.000Z'),
      expiresAt: Date.parse('2026-05-30T14:00:00.000Z'),
    });
    expect(codec.decode(capability)).not.toHaveProperty('outboundContainerId');
    vi.useRealTimers();
  });

  it.each([
    ['legacy unbound v1', 'kgh1.', 1, 2 * 60 * 60 * 1000, false],
    ['container-bound v2', 'kgh2.', 2, 4 * 60 * 60 * 1000, true],
  ] as const)(
    'rejects an overlong %s capability',
    (_description, prefix, version, maximumLifetimeMs, bound) => {
      const { outboundContainerId: _outboundContainerId, ...legacyClaims } = claims;
      const issuedAt = Date.now();
      const serializedClaims = JSON.stringify({
        purpose: 'github_scm_session',
        version,
        ...(bound ? claims : legacyClaims),
        issuedAt,
        expiresAt: issuedAt + maximumLifetimeMs + 1,
      });
      const capability = `${prefix}${encryptWithSymmetricKey(serializedClaims, encryptionKey)}`;

      expect(() => new GitHubSessionCapabilityCodec(encryptionKey).decode(capability)).toThrowError(
        expect.objectContaining({ reason: 'invalid_capability' })
      );
    }
  );

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

  it.each([
    ['another purpose', 'kgh2.', { purpose: 'another_use', version: 2 }],
    ['a v2 claim under the legacy marker', 'kgh1.', { purpose: 'github_scm_session', version: 2 }],
  ])('rejects decrypted claims with %s', (_description, prefix, boundClaims) => {
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);
    const serializedClaims = JSON.stringify({
      ...boundClaims,
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
    const capability = `${prefix}${encryptWithSymmetricKey(serializedClaims, encryptionKey)}`;

    expect(() => codec.decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });
});
