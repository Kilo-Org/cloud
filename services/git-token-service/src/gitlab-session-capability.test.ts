import { encryptWithSymmetricKey } from '@kilocode/encryption';
import { describe, expect, it, vi } from 'vitest';
import {
  GitLabSessionCapabilityCodec,
  GitLabSessionCapabilityError,
  parseGitLabCloneUrl,
} from './gitlab-session-capability.js';

const encryptionKey = Buffer.alloc(32, 7).toString('base64');
const anotherEncryptionKey = Buffer.alloc(32, 8).toString('base64');
const claims = {
  userId: 'user_1',
  outboundContainerId: 'outbound-container-1',
  orgId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145b',
  integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
  instanceOrigin: 'https://gitlab.example.com:8443/gitlab',
  projectPath: 'Acme/platform/widgets',
  authType: 'oauth',
  identity: { accountId: '42', accountLogin: 'octocat' },
  source: {
    type: 'project',
    projectId: 42,
    tokenDigest: 'f30b0bf364d41460c0119e521d2af8ae7eeacca9745981678d58b07b13c94edf',
  },
} as const;

describe('GitLabSessionCapabilityCodec', () => {
  it('produces an opaque four-hour prefixed capability with GitLab-bound claims', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T12:00:00.000Z'));
    const codec = new GitLabSessionCapabilityCodec(encryptionKey);

    const capability = codec.issue(claims);

    expect(capability).toMatch(/^kgl2\./);
    expect(capability).not.toContain('user_1');
    expect(capability).not.toContain('gitlab.example.com');
    expect(codec.decode(capability)).toEqual({
      purpose: 'gitlab_scm_session',
      version: 2,
      ...claims,
      issuedAt: Date.parse('2026-05-31T12:00:00.000Z'),
      expiresAt: Date.parse('2026-05-31T16:00:00.000Z'),
    });
    vi.useRealTimers();
  });

  it('produces and decodes a two-hour legacy unbound v1 capability when the container is omitted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T12:00:00.000Z'));
    const codec = new GitLabSessionCapabilityCodec(encryptionKey);
    const { outboundContainerId: _outboundContainerId, ...legacyClaims } = claims;

    const capability = codec.issue(legacyClaims);

    expect(capability).toMatch(/^kgl1\./);
    expect(codec.decode(capability)).toMatchObject({
      version: 1,
      userId: 'user_1',
      projectPath: 'Acme/platform/widgets',
      issuedAt: Date.parse('2026-05-31T12:00:00.000Z'),
      expiresAt: Date.parse('2026-05-31T14:00:00.000Z'),
    });
    expect(codec.decode(capability)).not.toHaveProperty('outboundContainerId');
    vi.useRealTimers();
  });

  it.each([
    ['legacy unbound v1', 'kgl1.', 1, 2 * 60 * 60 * 1000, false],
    ['container-bound v2', 'kgl2.', 2, 4 * 60 * 60 * 1000, true],
  ] as const)(
    'rejects an overlong %s capability',
    (_description, prefix, version, maximumLifetimeMs, bound) => {
      const { outboundContainerId: _outboundContainerId, ...legacyClaims } = claims;
      const issuedAt = Date.now();
      const serializedClaims = JSON.stringify({
        purpose: 'gitlab_scm_session',
        version,
        ...(bound ? claims : legacyClaims),
        issuedAt,
        expiresAt: issuedAt + maximumLifetimeMs + 1,
      });
      const capability = `${prefix}${encryptWithSymmetricKey(serializedClaims, encryptionKey)}`;

      expect(() => new GitLabSessionCapabilityCodec(encryptionKey).decode(capability)).toThrowError(
        expect.objectContaining({ reason: 'invalid_capability' })
      );
    }
  );

  it('rejects expiry, tampering, and another encryption key', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-31T12:00:00.000Z'));
    const codec = new GitLabSessionCapabilityCodec(encryptionKey);
    const capability = codec.issue(claims);
    const changedOffset = capability.lastIndexOf('.') + 4;
    const changedCharacter = capability[changedOffset] === 'A' ? 'B' : 'A';
    const tampered = `${capability.slice(0, changedOffset)}${changedCharacter}${capability.slice(changedOffset + 1)}`;

    expect(() => codec.decode(tampered)).toThrowError(GitLabSessionCapabilityError);
    expect(() =>
      new GitLabSessionCapabilityCodec(anotherEncryptionKey).decode(capability)
    ).toThrowError(expect.objectContaining({ reason: 'invalid_capability' }));
    vi.setSystemTime(new Date('2026-05-31T15:59:59.999Z'));
    expect(codec.decode(capability)).toMatchObject({ source: claims.source });
    vi.setSystemTime(new Date('2026-05-31T16:00:00.000Z'));
    expect(() => codec.decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'expired_capability' })
    );
    vi.useRealTimers();
  });

  it.each([
    ['another purpose', { purpose: 'github_scm_session' }],
    [
      'a malformed project-token digest',
      { source: { type: 'project', projectId: 42, tokenDigest: 'not-a-sha256-digest' } },
    ],
  ])('rejects encrypted claims with %s', (_description, overriddenClaims) => {
    const serializedClaims = JSON.stringify({
      purpose: 'gitlab_scm_session',
      version: 2,
      ...claims,
      ...overriddenClaims,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const capability = `kgl2.${encryptWithSymmetricKey(serializedClaims, encryptionKey)}`;

    expect(() => new GitLabSessionCapabilityCodec(encryptionKey).decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });

  it('rejects a v2 claim under the legacy marker', () => {
    const serializedClaims = JSON.stringify({
      purpose: 'gitlab_scm_session',
      version: 2,
      ...claims,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const capability = `kgl1.${encryptWithSymmetricKey(serializedClaims, encryptionKey)}`;

    expect(() => new GitLabSessionCapabilityCodec(encryptionKey).decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });
});

describe('parseGitLabCloneUrl', () => {
  const urlWithCredentials = new URL('https://gitlab.example.com/acme/widgets.git');
  urlWithCredentials.username = 'user';
  urlWithCredentials.password = 'pass';

  it.each([
    [
      'https://gitlab.com/acme/widgets.git',
      undefined,
      {
        instanceOrigin: 'https://gitlab.com',
        instanceHost: 'gitlab.com',
        projectPath: 'acme/widgets',
      },
    ],
    [
      'https://gitlab.example.com:8443/gitlab/Acme/platform/widgets.git',
      'https://gitlab.example.com:8443/gitlab/',
      {
        instanceOrigin: 'https://gitlab.example.com:8443/gitlab',
        instanceHost: 'gitlab.example.com:8443',
        projectPath: 'Acme/platform/widgets',
      },
    ],
  ])('accepts canonical nested GitLab clone URL %s', (gitUrl, instanceUrl, expected) => {
    expect(parseGitLabCloneUrl(gitUrl, instanceUrl)).toEqual({ success: true, ...expected });
  });

  it.each([
    ['http://gitlab.com/acme/widgets.git', undefined],
    ['https://gitlab.example.com:8443/acme/widgets.git', 'https://gitlab.example.com:9443'],
    ['https://gitlab.example.com/acme/widgets.git', 'https://gitlab.example.com/gitlab'],
    ['https://gitlab.example.com/acme/widgets.git', 'https://other.example.com'],
    ['https://gitlab.example.com/acme//widgets.git', 'https://gitlab.example.com'],
    ['https://gitlab.example.com/acme/../widgets.git', 'https://gitlab.example.com'],
    ['https://gitlab.example.com/acme%2Fwidgets.git', 'https://gitlab.example.com'],
    [urlWithCredentials.toString(), 'https://gitlab.example.com'],
    ['https://gitlab.example.com/acme/widgets.git?token=secret', 'https://gitlab.example.com'],
  ])('rejects unsafe or unsupported clone URL %s', (gitUrl, instanceUrl) => {
    expect(parseGitLabCloneUrl(gitUrl, instanceUrl).success).toBe(false);
  });
});
