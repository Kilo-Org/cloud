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

    expect(capability).toMatch(/^kgh1\./);
    expect(capability).not.toContain('user_1');
    expect(capability).not.toContain('acme');
    expect(decoded).toEqual({
      purpose: 'github_scm_session',
      version: 1,
      userId: 'user_1',
      orgId: claims.orgId,
      owner: 'acme',
      repo: 'widgets',
      source: 'user',
      identity: claims.identity,
      issuedAt: Date.parse('2026-05-30T12:00:00.000Z'),
      expiresAt: Date.parse('2026-05-30T13:00:00.000Z'),
    });
    vi.useRealTimers();
  });

  it('rejects expired and tampered capabilities', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-30T12:00:00.000Z'));
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);
    const capability = codec.issue(claims);

    vi.setSystemTime(new Date('2026-05-30T12:59:59.999Z'));
    expect(codec.decode(capability)).toMatchObject({ source: 'user' });

    vi.setSystemTime(new Date('2026-05-30T13:00:00.000Z'));
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
    { purpose: 'another_use', version: 1 },
    { purpose: 'github_scm_session', version: 2 },
  ])('rejects decrypted claims bound to $purpose purpose and v$version', boundClaims => {
    const codec = new GitHubSessionCapabilityCodec(encryptionKey);
    const serializedClaims = JSON.stringify({
      ...boundClaims,
      userId: 'user_1',
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
    const capability = `kgh1.${encryptWithSymmetricKey(serializedClaims, encryptionKey)}`;

    expect(() => codec.decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });
});
