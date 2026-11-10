import { encryptWithSymmetricKey } from '@kilocode/encryption';
import { describe, expect, it, vi } from 'vitest';
import {
  GitLabSessionCapabilityCodec,
  GitLabSessionCapabilityError,
  parseGitLabCloneUrl,
  validateGitLabSessionCapabilityPath,
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

  it('rejects issuance without a container binding', () => {
    const codec = new GitLabSessionCapabilityCodec(encryptionKey);

    expect(() => codec.issue({ ...claims, outboundContainerId: '' })).toThrowError(
      expect.objectContaining({ reason: 'capability_configuration_error' })
    );
  });

  it('rejects a legacy unbound capability', () => {
    const codec = new GitLabSessionCapabilityCodec(encryptionKey);
    const issuedAt = Date.now();
    const { outboundContainerId: _outboundContainerId, ...legacyClaims } = {
      ...claims,
      purpose: 'gitlab_scm_session',
      version: 1,
      issuedAt,
      expiresAt: issuedAt + 60_000,
    };
    const capability = `kgl1.${encryptWithSymmetricKey(JSON.stringify(legacyClaims), encryptionKey)}`;

    expect(() => codec.decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });

  it('binds a new project capability to the encrypted credential generation', () => {
    const codec = new GitLabSessionCapabilityCodec(encryptionKey);
    const capability = codec.issue({
      ...claims,
      source: {
        type: 'project',
        projectId: 42,
        credentialId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145d',
        credentialVersion: 3,
      },
    });

    expect(codec.decode(capability).source).toEqual({
      type: 'project',
      projectId: 42,
      credentialId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145d',
      credentialVersion: 3,
    });
  });

  it('binds an OAuth integration capability to the stable credential ID without its refresh version', () => {
    const codec = new GitLabSessionCapabilityCodec(encryptionKey);
    const capability = codec.issue({
      ...claims,
      source: {
        type: 'integration',
        credentialId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145d',
      },
    });

    expect(codec.decode(capability).source).toEqual({
      type: 'integration',
      credentialId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145d',
    });
  });

  it('rejects an overlong container-bound capability', () => {
    const issuedAt = Date.now();
    const serializedClaims = JSON.stringify({
      purpose: 'gitlab_scm_session',
      version: 2,
      ...claims,
      issuedAt,
      expiresAt: issuedAt + 4 * 60 * 60 * 1000 + 1,
    });
    const capability = `kgl2.${encryptWithSymmetricKey(serializedClaims, encryptionKey)}`;

    expect(() => new GitLabSessionCapabilityCodec(encryptionKey).decode(capability)).toThrowError(
      expect.objectContaining({ reason: 'invalid_capability' })
    );
  });

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
});

describe.each([{ type: 'integration' }, claims.source] as const)(
  'GitLab request paths for $type credentials',
  source => {
    const codec = new GitLabSessionCapabilityCodec(encryptionKey);
    const session = codec.decode(codec.issue({ ...claims, source }));
    const prefix = '/gitlab/api/v4/projects/';

    it.each([
      [`${prefix}Acme%2Fplatform%2Fwidgets`, null, 'api'],
      [`${prefix}Acme%2fplatform%2fwidgets/merge_requests/7/approval_state`, null, 'api'],
      [`${prefix}Acme%2Fplatform%2Fwidgets/repository/files/src%2Fmain.ts/raw`, null, 'api'],
      [
        `${prefix}42/merge_requests/7`,
        source.type === 'project' ? null : 'repository_mismatch',
        'api',
      ],
      [
        `${prefix}%34%32/merge_requests/7`,
        source.type === 'project' ? null : 'repository_mismatch',
        'api',
      ],
      [`${prefix}042/merge_requests/7`, 'repository_mismatch', 'api'],
      [`${prefix}420/merge_requests/7`, 'repository_mismatch', 'api'],
      [`${prefix}43/merge_requests/7`, 'repository_mismatch', 'api'],
      [`${prefix}Acme%2Fplatform%2Fother/issues`, 'repository_mismatch', 'api'],
      [`${prefix}Acme%2Fplatform%2Fwidgets-extra/issues`, 'repository_mismatch', 'api'],
      [`${prefix}Acme%2Fplatform%2Fwidgets.json/access_tokens`, 'repository_mismatch', 'api'],
      [
        `${prefix}42/access_tokens`,
        source.type === 'project' ? 'invalid_upstream_request' : 'repository_mismatch',
        'api',
      ],
      [`${prefix}Acme%252Fplatform%252Fwidgets/issues`, 'repository_mismatch', 'api'],
      [`${prefix}Acme%2Fplatform%2Fwidgets%2Fextra/issues`, 'repository_mismatch', 'api'],
      [`${prefix}Acme%2Fplatform%2Fwidgets%/issues`, 'invalid_upstream_url', 'api'],
      [`${prefix}/issues`, 'invalid_upstream_url', 'api'],
      ['/gitlab/api/v4/projects', 'invalid_upstream_request', 'api'],
      ['/gitlab/api/v4/user', 'invalid_upstream_request', 'api'],
      ['/gitlab/api/graphql', 'invalid_upstream_request', 'api'],
      ['/gitlab/Acme/platform/widgets.git/info/refs', null, 'git'],
      ['/gitlab/Acme/platform/widgets.git/git-upload-pack', null, 'git'],
      ['/gitlab/Acme/platform/widgets.git/info/lfs/locks/123/unlock', null, 'git'],
      ['/gitlab/Acme/platform/other.git/info/refs', 'repository_mismatch', 'git'],
      ['/gitlab/Acme/platform/widgets', 'invalid_upstream_request', 'git'],
      ['/gitlab/Acme/platform/widgets.git/archive/main.zip', 'invalid_upstream_request', 'git'],
    ] as const)('evaluates request path %s', (pathname, failure, authSurface) => {
      expect(validateGitLabSessionCapabilityPath('GET', pathname, session, '/gitlab')).toEqual({
        failure,
        authSurface,
      });
    });

    it.each(['api/project', 'api/v4/project', 'api/v4/projects/project'])(
      'selects Git authentication for %s',
      projectPath => {
        expect(
          validateGitLabSessionCapabilityPath(
            'GET',
            `/gitlab/${projectPath}.git/info/refs`,
            { ...session, projectPath },
            '/gitlab'
          )
        ).toEqual({ failure: null, authSurface: 'git' });
      }
    );

    const project = `${prefix}Acme%2Fplatform%2Fwidgets`;

    it.each([
      ['DELETE', project],
      ['PUT', project],
      ['POST', `${project}/access_tokens`],
      ['POST', `${project}/access_tokens.json`],
      ['POST', `${project}/%61ccess_tokens%2Ejson`],
      ['GET', `${project}/variables.xml`],
      ['GET', `${project}/access_tokens`],
      ['POST', `${project}/%61ccess_tokens`],
      ['POST', `${project}/access_tokens%2F1`],
      ['DELETE', `${project}/deploy_tokens/12`],
      ['POST', `${project}/deploy_keys`],
      ['POST', `${project}/triggers`],
      ['POST', `${project}/job_token_scope`],
      ['POST', `${project}/secure_files`],
      ['GET', `${project}/variables`],
      ['POST', `${project}/variables`],
      ['POST', `${project}/hooks`],
      ['PUT', `${project}/hooks/3`],
      ['DELETE', `${project}/hooks/3`],
      ['POST', `${project}/members`],
      ['PUT', `${project}/members/7`],
      ['PUT', `${project}/access_requests/7/approve`],
      ['DELETE', `${project}/access_requests/7`],
      ['POST', `${project}/remote_mirrors`],
      ['PUT', `${project}/remote_mirrors/1`],
      ['POST', `${project}/invitations`],
      ['PUT', `${project}/share`],
      ['PUT', `${project}/protected_branches`],
      ['DELETE', `${project}/protected_tags/v1`],
      ['PUT', `${project}/protected_environments/production`],
      ['PUT', `${project}/integrations/slack`],
      ['POST', `${project}/runners`],
      ['PUT', `${project}/push_rule`],
      ['POST', `${project}/archive`],
      ['POST', `${project}/unarchive`],
      ['POST', `${project}/transfer`],
      ['POST', `${project}/export`],
    ] as const)('refuses %s %s', (method, pathname) => {
      expect(validateGitLabSessionCapabilityPath(method, pathname, session, '/gitlab')).toEqual({
        failure: 'invalid_upstream_request',
        authSurface: 'api',
      });
    });

    it.each([
      ['GET', project],
      ['HEAD', project],
      ['GET', `${project}/hooks`],
      ['GET', `${project}/members/all`],
      ['GET', `${project}/access_requests`],
      ['GET', `${project}/remote_mirrors`],
      ['GET', `${project}/protected_branches`],
      ['GET', `${project}/merge_requests`],
      ['POST', `${project}/merge_requests`],
      ['GET', `${project}/merge_requests.json`],
      ['PATCH', `${project}/issues/1.json`],
      ['GET', `${project}/hooks.json`],
      ['PUT', `${project}/merge_requests/7/notes/3`],
      ['POST', `${project}/merge_requests/7/discussions`],
      ['POST', `${project}/%6Derge_requests`],
      ['POST', `${project}/issues`],
      ['POST', `${project}/pipelines/12/retry`],
      ['DELETE', `${project}/repository/branches/feature%2Fdeploy`],
      ['POST', `${project}/repository/files/src%2Fmain.ts`],
      ['GET', `${project}/repository/files/src%2Fmain.ts/raw`],
      ['POST', `${project}/releases`],
      ['DELETE', `${project}/merge_requests/7`],
      ['POST', '/gitlab/Acme/platform/widgets.git/git-receive-pack'],
      ['POST', '/gitlab/Acme/platform/widgets.git/info/lfs/objects/batch'],
      ['POST', '/gitlab/Acme/platform/widgets.git/info/lfs/locks/verify'],
    ] as const)('permits %s %s', (method, pathname) => {
      expect(
        validateGitLabSessionCapabilityPath(method, pathname, session, '/gitlab').failure
      ).toBe(null);
    });
  }
);

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
