import { describe, expect, it } from 'vitest';
import {
  additionalEnvironmentMembers,
  additionalGitCredentials,
  EnvironmentMemberCredentialError,
  grantScmAliases,
  memberCredentialFailureStage,
  memberCredentialRepository,
  resolveAdditionalMembers,
  selectScmEntry,
  type GrantRepositories,
} from './session-credential-members.js';
import {
  persistedSessionCredentialGrantSchema,
  removeSessionCredentialMembership,
  type AdditionalScmRepository,
  type ScmGrant,
} from './session-credentials.js';
import { createControlPlaneCredential } from './managed-credential.js';

const SANDBOX_ID = `sbx-${'a'.repeat(48)}`;
const GITHUB_ALIAS = createControlPlaneCredential(SANDBOX_ID, 'github');
const GITLAB_ALIAS = createControlPlaneCredential(SANDBOX_ID, 'gitlab');
const BITBUCKET_ALIAS = createControlPlaneCredential(SANDBOX_ID, 'bitbucket');
const WORKSPACE_UUID = '11111111-1111-4111-8111-111111111111';
const REPOSITORY_UUID = '22222222-2222-4222-8222-222222222222';

const NOW = Date.now();
const capability = (credential: string) => ({
  credential,
  outboundContainerId: 'oc_1',
  issuedAt: NOW,
  expiresAt: NOW + 60_000,
});

function githubEntry(repo: string, credential: string) {
  return {
    repository: {
      type: 'github' as const,
      repo,
      authentication: 'managed' as const,
      allowUserAuthorization: false,
    },
    scm: {
      purpose: 'github' as const,
      alias: GITHUB_ALIAS,
      gitUrl: `https://github.com/${repo}.git`,
      capability: capability(`kgh2.${credential}`),
    },
  };
}

function gitlabEntry(origin: string, projectPath: string, credential: string) {
  const host = new URL(origin).host;
  return {
    repository: { type: 'gitlab' as const, url: `${origin}/${projectPath}.git` },
    scm: {
      purpose: 'gitlab' as const,
      alias: GITLAB_ALIAS,
      gitUrl: `${origin}/${projectPath}.git`,
      capability: capability(`kgl2.${credential}`),
      gitlab: {
        instanceOrigin: origin,
        instanceHost: host,
        projectPath,
        integrationId: 'integration-1',
        authType: 'pat' as const,
        identity: { accountId: null, accountLogin: null },
        glabIsOAuth2: false,
      },
    },
  };
}

function bitbucketEntry(workspace: string, slug: string, credential: string) {
  return {
    repository: {
      type: 'bitbucket' as const,
      url: `https://bitbucket.org/${workspace}/${slug}.git`,
      workspaceUuid: WORKSPACE_UUID,
      repositoryUuid: REPOSITORY_UUID,
    },
    scm: {
      purpose: 'bitbucket' as const,
      alias: BITBUCKET_ALIAS,
      gitUrl: `https://bitbucket.org/${workspace}/${slug}.git`,
      capability: capability(`kbb1.${credential}`),
    },
  };
}

type Entry = { repository: AdditionalScmRepository['repository']; scm: ScmGrant };

/** The members input of `resolveAdditionalMembers`, named by their repository. */
function membersOf(...repositories: Array<AdditionalScmRepository['repository']>) {
  return repositories.map(repository => ({
    repoFullName:
      repository.type === 'github'
        ? repository.repo
        : new URL(repository.url).pathname.slice(1).replace(/\.git$/, ''),
    repository,
  }));
}

/** A V2 grant: the first entry is the launch repository. */
function grantOf(launch: Entry, ...additional: Entry[]): GrantRepositories {
  return {
    repository: launch.repository,
    scm: launch.scm,
    ...(additional.length > 0 ? { additionalRepositories: additional } : {}),
  };
}

/** The credential the selection serves for a request, by the digits of its fixture capability. */
function selected(grant: GrantRepositories, alias: string, url: string): string | undefined {
  return selectScmEntry(grant, alias, new URL(url))?.scm.capability?.credential.split('.')[1];
}

describe('selecting a repository from the request URL', () => {
  const github = grantOf(
    githubEntry('acme/widgets', 'launch'),
    githubEntry('acme/gadgets', 'gadgets'),
    githubEntry('Other/Lib', 'lib')
  );

  it.each([
    [
      'git over HTTPS',
      'https://github.com/acme/gadgets.git/info/refs?service=git-upload-pack',
      'gadgets',
    ],
    ['git without the .git suffix', 'https://github.com/acme/gadgets/git-receive-pack', 'gadgets'],
    ['a repository path with another case', 'https://github.com/OTHER/lib.git/info/refs', 'lib'],
    ['the REST API', 'https://api.github.com/repos/acme/gadgets/pulls/1', 'gadgets'],
    [
      'the REST API with another case',
      'https://api.github.com/repos/Acme/Gadgets/issues',
      'gadgets',
    ],
    ['the launch repository', 'https://github.com/acme/widgets.git/info/refs', 'launch'],
  ])('uses the member that %s names', (_name, url, expected) => {
    expect(selected(github, GITHUB_ALIAS, url)).toBe(expected);
  });

  it.each([
    ['a repository that is no member', 'https://github.com/acme/unknown.git/info/refs'],
    [
      'a name that only starts like a member',
      'https://github.com/acme/gadgets-extra.git/info/refs',
    ],
    ['an API call with no repository', 'https://api.github.com/graphql'],
    ['the user API', 'https://api.github.com/user'],
    ['an API path of another resource', 'https://api.github.com/orgs/acme/repos'],
    ['another host', 'https://example.com/acme/gadgets.git/info/refs'],
  ])('falls back to the launch repository for %s', (_name, url) => {
    expect(selected(github, GITHUB_ALIAS, url)).toBe('launch');
  });

  it('serves a GitLab project below subgroups and an instance base path', () => {
    const origin = 'https://git.example.com/gitlab';
    const grant = grantOf(
      githubEntry('acme/widgets', 'launch'),
      gitlabEntry(origin, 'group/sub/project', 'project'),
      gitlabEntry(origin, 'group/sub/other', 'other')
    );
    const url = (path: string) => `https://git.example.com${path}`;

    expect(selected(grant, GITLAB_ALIAS, url('/gitlab/group/sub/project.git/info/refs'))).toBe(
      'project'
    );
    expect(selected(grant, GITLAB_ALIAS, url('/gitlab/Group/Sub/Other/git-receive-pack'))).toBe(
      'other'
    );
    // The API names the project as one encoded segment under the base path.
    expect(
      selected(
        grant,
        GITLAB_ALIAS,
        url('/gitlab/api/v4/projects/group%2Fsub%2Fother/merge_requests')
      )
    ).toBe('other');
    expect(
      selected(grant, GITLAB_ALIAS, url('/gitlab/api/v4/projects/group%2fsub%2fproject'))
    ).toBe('project');
    // A name that only starts like a project, a numeric project id and GraphQL name no
    // member: the first entry that holds the GitLab alias serves them.
    expect(
      selected(grant, GITLAB_ALIAS, url('/gitlab/group/sub/project-extra.git/info/refs'))
    ).toBe('project');
    expect(selected(grant, GITLAB_ALIAS, url('/gitlab/api/v4/projects/42/merge_requests'))).toBe(
      'project'
    );
    expect(selected(grant, GITLAB_ALIAS, url('/gitlab/api/graphql'))).toBe('project');
    // The base path is part of the project's address.
    expect(selected(grant, GITLAB_ALIAS, url('/group/sub/other.git/info/refs'))).toBe('project');
  });

  it('keeps the projects of two GitLab instances apart', () => {
    const grant = grantOf(
      gitlabEntry('https://gitlab.com', 'team/app', 'dotcom'),
      gitlabEntry('https://git.example.com', 'team/app', 'selfhosted')
    );
    expect(selected(grant, GITLAB_ALIAS, 'https://git.example.com/team/app.git/info/refs')).toBe(
      'selfhosted'
    );
    expect(selected(grant, GITLAB_ALIAS, 'https://gitlab.com/team/app.git/info/refs')).toBe(
      'dotcom'
    );
  });

  it('serves a Bitbucket repository by its path or by its API path', () => {
    const grant = grantOf(
      githubEntry('acme/widgets', 'launch'),
      bitbucketEntry('team', 'repo', 'repo')
    );
    expect(selected(grant, BITBUCKET_ALIAS, 'https://bitbucket.org/Team/Repo.git/info/refs')).toBe(
      'repo'
    );
    expect(
      selected(
        grant,
        BITBUCKET_ALIAS,
        'https://api.bitbucket.org/2.0/repositories/team/repo/pullrequests'
      )
    ).toBe('repo');
    // The CLI addresses a repository by its encoded brace-wrapped UUIDs.
    expect(
      selected(
        grant,
        BITBUCKET_ALIAS,
        `https://api.bitbucket.org/2.0/repositories/%7B${WORKSPACE_UUID}%7D/%7B${REPOSITORY_UUID}%7D/pullrequests`
      )
    ).toBe('repo');
  });

  // The selector only routes; redemption enforces the repository of the chosen
  // capability. These cases fix what a crafted URL selects, so a change of the
  // routing is a visible decision.
  describe('a crafted GitHub URL', () => {
    it.each([
      [
        'a dot segment that leads to another member',
        'https://github.com/acme/widgets/../gadgets.git/info/refs',
        'gadgets',
      ],
      [
        'an encoded dot segment that leads to another member',
        'https://github.com/acme/widgets/%2e%2e/gadgets.git/info/refs',
        'gadgets',
      ],
      [
        'a dot segment that leaves a member for the launch repository',
        'https://github.com/acme/gadgets/../widgets.git/info/refs',
        'launch',
      ],
      [
        'a backslash, which URL parsing turns into a slash',
        'https://github.com/acme\\gadgets.git/info/refs',
        'gadgets',
      ],
      ['a trailing slash', 'https://github.com/acme/gadgets.git/', 'gadgets'],
      [
        'userinfo and the default port',
        'https://user@github.com:443/acme/gadgets.git/info/refs',
        'gadgets',
      ],
    ])('follows the normalized path for %s', (_name, url, expected) => {
      expect(selected(github, GITHUB_ALIAS, url)).toBe(expected);
    });

    it.each([
      [
        'an encoded slash in the repository path',
        'https://github.com/acme%2Fgadgets.git/info/refs',
      ],
      [
        'a double-encoded slash in the repository path',
        'https://github.com/acme%252Fgadgets.git/info/refs',
      ],
      [
        'an encoded slash in the API repository path',
        'https://api.github.com/repos/acme%2Fgadgets/pulls',
      ],
      ['an empty first path segment', 'https://github.com//acme/gadgets.git/info/refs'],
      ['a doubled .git suffix', 'https://github.com/acme/gadgets.git.git/info/refs'],
      ['an encoded dot in the .git suffix', 'https://github.com/acme/gadgets%2egit/info/refs'],
      [
        'a member named only in the query',
        'https://github.com/acme/widgets.git/info/refs?next=/acme/gadgets.git',
      ],
      [
        'a member named only in the fragment',
        'https://github.com/acme/widgets.git/info/refs#/acme/gadgets.git',
      ],
      ['an upload host that no member uses', 'https://uploads.github.com/acme/gadgets/releases'],
    ])('names no member for %s, so the launch capability serves it', (_name, url) => {
      expect(selected(github, GITHUB_ALIAS, url)).toBe('launch');
    });
  });

  describe('a crafted GitLab URL', () => {
    const grant = grantOf(
      githubEntry('acme/widgets', 'launch'),
      gitlabEntry('https://gitlab.com', 'group/a', 'a'),
      gitlabEntry('https://gitlab.com', 'group/a-b', 'ab')
    );

    it('keeps a project whose name extends a member apart from that member', () => {
      expect(selected(grant, GITLAB_ALIAS, 'https://gitlab.com/group/a-b.git/info/refs')).toBe(
        'ab'
      );
      expect(selected(grant, GITLAB_ALIAS, 'https://gitlab.com/group/a.git/info/refs')).toBe('a');
    });

    it.each([
      ['a double-encoded API selector', 'https://gitlab.com/api/v4/projects/group%252Fa-b/issues'],
      ['an API selector with an encoded dot segment', 'https://gitlab.com/api/v4/projects/%2e%2e'],
      ['a numeric project id', 'https://gitlab.com/api/v4/projects/7/issues'],
      ['a host that no member uses', 'https://other.example.com/group/a-b.git/info/refs'],
    ])('names no member for %s, so the first GitLab entry serves it', (_name, url) => {
      expect(selected(grant, GITLAB_ALIAS, url)).toBe('a');
    });

    it('routes a project below a member to that member; redemption refuses the project', () => {
      // `group/a/b` is a different project from the member `group/a`. The selector
      // picks the longest member prefix, and the capability of `group/a` is bound
      // to that project, so it cannot serve `group/a/b`.
      expect(selected(grant, GITLAB_ALIAS, 'https://gitlab.com/group/a/b.git/info/refs')).toBe('a');
    });
  });

  it('serves a request only from an entry that holds its alias', () => {
    const grant = grantOf(
      githubEntry('acme/widgets', 'launch'),
      gitlabEntry('https://gitlab.com', 'g/p', 'p')
    );
    expect(selected(grant, GITLAB_ALIAS, 'https://github.com/acme/widgets.git/info/refs')).toBe(
      'p'
    );
    expect(selected(grant, GITHUB_ALIAS, 'https://gitlab.com/g/p.git/info/refs')).toBe('launch');
    expect(
      selectScmEntry(grant, 'kcp1.other', new URL('https://github.com/acme/widgets'))
    ).toBeNull();
  });

  it('never reads the URL of a grant with one repository', () => {
    const grant = grantOf(githubEntry('acme/widgets', 'launch'));
    expect(selected(grant, GITHUB_ALIAS, 'https://github.com/acme/other.git/info/refs')).toBe(
      'launch'
    );
    expect(grantScmAliases(grant)).toEqual([GITHUB_ALIAS]);
  });
});

describe('the hosts a wrapper needs a record for', () => {
  it('lists each host other than the launch host once, with its alias', () => {
    const grant = grantOf(
      githubEntry('acme/widgets', 'launch'),
      githubEntry('acme/gadgets', 'gadgets'),
      gitlabEntry('https://gitlab.com', 'g/p', 'p'),
      gitlabEntry('https://gitlab.com', 'g/q', 'q'),
      gitlabEntry('https://git.example.com', 'g/r', 'r')
    );
    expect(additionalGitCredentials(grant)).toEqual([
      { url: 'https://gitlab.com/g/p.git', token: GITLAB_ALIAS, platform: 'gitlab' },
      { url: 'https://git.example.com/g/r.git', token: GITLAB_ALIAS, platform: 'gitlab' },
    ]);
    expect(grantScmAliases(grant)).toEqual([GITHUB_ALIAS, GITLAB_ALIAS]);
  });

  it('lists none for a grant whose members share the launch host', () => {
    expect(
      additionalGitCredentials(
        grantOf(githubEntry('acme/widgets', 'launch'), githubEntry('acme/gadgets', 'gadgets'))
      )
    ).toEqual([]);
  });
});

describe('the members of an environment beside the launch repository', () => {
  const member = (repoFullName: string) => ({
    identity: { platform: 'github' as const, repoFullName },
    repoFullName,
    leaf: repoFullName.slice(repoFullName.indexOf('/') + 1),
    branch: 'kilo/session',
  });

  it('excludes the launch repository by identity, not by spelling', () => {
    const members = [member('acme/widgets'), member('acme/gadgets'), member('other/lib')];
    expect(
      additionalEnvironmentMembers(
        { repositories: members },
        { type: 'github', repo: 'Acme/Widgets' }
      ).map(entry => entry.repoFullName)
    ).toEqual(['acme/gadgets', 'other/lib']);
  });

  it('has none for a V1 environment or no environment', () => {
    const launch = { type: 'github' as const, repo: 'acme/widgets' };
    expect(additionalEnvironmentMembers({}, launch)).toEqual([]);
    expect(additionalEnvironmentMembers(null, launch)).toEqual([]);
    expect(additionalEnvironmentMembers(undefined, launch)).toEqual([]);
  });

  it('refuses an environment that does not contain the launch repository', () => {
    expect(() =>
      additionalEnvironmentMembers(
        { repositories: [member('acme/gadgets')] },
        { type: 'github', repo: 'acme/widgets' }
      )
    ).toThrow();
  });

  const githubMember = {
    identity: { platform: 'github' as const, repoFullName: 'acme/gadgets' },
    repoFullName: 'acme/gadgets',
    leaf: 'gadgets',
  };

  it('gives a GitHub member the purpose of a GitHub launch and never its integration pin', () => {
    expect(
      memberCredentialRepository(githubMember, {
        type: 'github',
        repo: 'acme/widgets',
        githubIntegrationId: '11111111-1111-4111-8111-111111111112',
        githubAccessPurpose: 'agent',
      })
    ).toEqual({ type: 'github', repo: 'acme/gadgets', githubAccessPurpose: 'agent' });
  });

  it.each([
    [
      'a GitHub launch with a pin and no purpose',
      {
        type: 'github' as const,
        repo: 'acme/widgets',
        githubIntegrationId: '11111111-1111-4111-8111-111111111112',
      },
    ],
    ['a GitLab launch', { type: 'gitlab' as const, url: 'https://gitlab.com/g/p.git' }],
    ['no launch', undefined],
  ])('gives a GitHub member the default access for %s', (_name, launch) => {
    expect(memberCredentialRepository(githubMember, launch)).toEqual({
      type: 'github',
      repo: 'acme/gadgets',
    });
  });

  it('builds the credential repository of a Bitbucket member from its path', () => {
    expect(
      memberCredentialRepository(
        {
          identity: {
            platform: 'bitbucket',
            workspaceUuid: WORKSPACE_UUID,
            repositoryUuid: REPOSITORY_UUID,
          },
          repoFullName: 'team/repo',
          leaf: 'repo',
        },
        undefined
      )
    ).toEqual({
      type: 'bitbucket',
      url: 'https://bitbucket.org/team/repo.git',
      workspaceUuid: WORKSPACE_UUID,
      repositoryUuid: REPOSITORY_UUID,
    });
  });
});

describe('resolving the capability of each additional repository', () => {
  it('gives every repository of one purpose the alias of that purpose', async () => {
    const launch = githubEntry('acme/widgets', 'launch');
    const issued: string[] = [];
    const entries = await resolveAdditionalMembers({
      members: membersOf(
        githubEntry('acme/gadgets', 'x').repository,
        gitlabEntry('https://gitlab.com', 'g/p', 'x').repository,
        gitlabEntry('https://gitlab.com', 'g/q', 'x').repository
      ),
      launchScm: launch.scm,
      existing: undefined,
      refresh: async repository => {
        const type = repository.type;
        issued.push(type);
        // The issuer mints a fresh alias for each call, as the real one does.
        return {
          purpose: type,
          alias: createControlPlaneCredential(SANDBOX_ID, type),
          gitUrl: 'url' in repository ? repository.url : 'https://github.com/x/y.git',
        } as ScmGrant;
      },
    });
    expect(issued).toEqual(['github', 'gitlab', 'gitlab']);
    expect(entries[0]?.scm.alias).toBe(GITHUB_ALIAS);
    expect(entries[1]?.scm.alias).toBeDefined();
    expect(entries[1]?.scm.alias).not.toBe(GITHUB_ALIAS);
    expect(entries[2]?.scm.alias).toBe(entries[1]?.scm.alias);
  });

  it('issues the capabilities together, not one after another', async () => {
    const launch = githubEntry('acme/widgets', 'launch');
    let started = 0;
    let release: () => void = () => {};
    const bothStarted = new Promise<void>(resolve => {
      release = resolve;
    });
    const entries = await resolveAdditionalMembers({
      members: membersOf(
        githubEntry('acme/gadgets', 'x').repository,
        githubEntry('acme/lib', 'x').repository
      ),
      launchScm: launch.scm,
      existing: undefined,
      refresh: async () => {
        started += 1;
        if (started === 2) release();
        // Each issuance waits for the other to start: sequential calls never finish.
        await bothStarted;
        return launch.scm;
      },
    });
    expect(entries).toHaveLength(2);
  });

  it('fails the whole resolution with an error that names the failing repository', async () => {
    const launch = githubEntry('acme/widgets', 'launch');
    const error = await resolveAdditionalMembers({
      members: membersOf(
        githubEntry('acme/gadgets', 'x').repository,
        githubEntry('acme/lib', 'x').repository
      ),
      launchScm: launch.scm,
      existing: undefined,
      refresh: async repository => {
        if (repository.type === 'github' && repository.repo === 'acme/lib') {
          throw new Error('capability issuance is unavailable');
        }
        return launch.scm;
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentMemberCredentialError);
    expect((error as EnvironmentMemberCredentialError).repoFullName).toBe('acme/lib');
    expect((error as Error).cause).toEqual(new Error('capability issuance is unavailable'));
  });

  it('names the first failing repository in environment order, not the first to fail', async () => {
    const launch = githubEntry('acme/widgets', 'launch');
    const error = await resolveAdditionalMembers({
      members: membersOf(
        githubEntry('acme/gadgets', 'x').repository,
        githubEntry('acme/lib', 'x').repository
      ),
      launchScm: launch.scm,
      existing: undefined,
      refresh: async repository => {
        if (repository.type === 'github' && repository.repo === 'acme/gadgets') {
          // Settles after the other failure.
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('capability issuance is unavailable');
      },
    }).catch((caught: unknown) => caught);

    expect((error as EnvironmentMemberCredentialError).repoFullName).toBe('acme/gadgets');
  });

  it('names a GitLab member by its project path and gives a stage that carries the name', async () => {
    const launch = githubEntry('acme/widgets', 'launch');
    const error = await resolveAdditionalMembers({
      members: membersOf(gitlabEntry('https://gitlab.com', 'group/sub/project', 'x').repository),
      launchScm: launch.scm,
      existing: undefined,
      refresh: async () => {
        throw new Error('GitLab capability issuance is unavailable');
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentMemberCredentialError);
    expect(memberCredentialFailureStage(error as EnvironmentMemberCredentialError)).toBe(
      'member_credential_failed:group_sub_project'
    );
  });
});

describe('a persisted V2 grant', () => {
  const kiloAlias = createControlPlaneCredential(SANDBOX_ID, 'kilo');

  function persisted(overrides: Record<string, unknown> = {}) {
    const launch = githubEntry('acme/widgets', 'launch');
    const gadgets = githubEntry('acme/gadgets', 'gadgets');
    const project = gitlabEntry('https://gitlab.com', 'g/p', 'p');
    return {
      version: 1,
      scopeId: 'scope_1',
      directory: '/workspace',
      sandboxId: SANDBOX_ID,
      userId: 'user_1',
      provider: 'cloudflare-containers',
      outboundContainerId: 'oc_1',
      members: [
        {
          sessionId: 'workspace_11111111-1111-1111-1111-111111111111',
          kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        {
          sessionId: 'workspace_22222222-2222-2222-2222-222222222222',
          kiloSessionId: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
      repository: launch.repository,
      scm: launch.scm,
      additionalRepositories: [gadgets, project],
      kilo: {
        alias: kiloAlias,
        token: 'kilo-token',
        targets: {
          backendBaseUrl: 'https://api.kilo.ai',
          providerBaseUrl: 'https://api.kilo.ai',
          sessionIngestBaseUrl: 'https://ingest.kilosessions.ai',
        },
        capabilities: {},
      },
      preparedAt: NOW,
      expiresAt: NOW + 60_000,
      ...overrides,
    };
  }

  it('is valid when each purpose has one alias', () => {
    expect(persistedSessionCredentialGrantSchema.safeParse(persisted()).success).toBe(true);
  });

  it('is invalid when two repositories of one purpose hold different aliases', () => {
    const other = { ...githubEntry('acme/gadgets', 'gadgets') };
    other.scm = { ...other.scm, alias: createControlPlaneCredential(SANDBOX_ID, 'github') };
    expect(
      persistedSessionCredentialGrantSchema.safeParse(
        persisted({ additionalRepositories: [other] })
      ).success
    ).toBe(false);
  });

  it('is invalid when two purposes share an alias', () => {
    const project = gitlabEntry('https://gitlab.com', 'g/p', 'p');
    project.scm = { ...project.scm, alias: GITHUB_ALIAS };
    expect(
      persistedSessionCredentialGrantSchema.safeParse(
        persisted({ additionalRepositories: [project] })
      ).success
    ).toBe(false);
  });

  // Each grant below is valid for its mode without `additionalRepositories`, so a
  // failure with them comes from the rule that only a contained grant served by
  // the outbound proxy can hold several repositories.
  it.each([
    [
      'direct',
      { containmentEnabled: false },
      () => ({
        purpose: 'github' as const,
        gitUrl: 'https://github.com/acme/widgets.git',
        nativeToken: 'ghs_native',
      }),
    ],
    [
      'Vercel',
      { provider: 'vercel' },
      () => ({
        purpose: 'github' as const,
        alias: GITHUB_ALIAS,
        gitUrl: 'https://github.com/acme/widgets.git',
        nativeToken: 'ghs_native',
      }),
    ],
  ])('is invalid on a %s grant that holds additional repositories', (name, mode, launchScm) => {
    const launch = githubEntry('acme/widgets', 'launch');
    const gadgets = { ...githubEntry('acme/gadgets', 'gadgets'), scm: launchScm() };
    const base = persisted();
    // A direct grant is a legacy one: its Kilo credential has no alias.
    const kilo = name === 'direct' ? { ...base.kilo, alias: undefined } : base.kilo;
    const grant = persisted({ ...mode, kilo, scm: launchScm(), repository: launch.repository });
    const without = { ...grant, additionalRepositories: undefined };
    const withMembers = { ...grant, additionalRepositories: [gadgets] };

    expect(persistedSessionCredentialGrantSchema.safeParse(without).success).toBe(true);
    expect(persistedSessionCredentialGrantSchema.safeParse(withMembers).success).toBe(false);
  });

  it('is invalid without a launch capability', () => {
    expect(
      persistedSessionCredentialGrantSchema.safeParse(
        persisted({ repository: undefined, scm: undefined })
      ).success
    ).toBe(false);
  });

  it('keeps every member capability while one session leaves, and drops them with the last', () => {
    const grant = persistedSessionCredentialGrantSchema.parse(persisted());
    const [first, second] = grant.members;
    if (!first || !second) throw new Error('fixture needs two sessions');

    const [remaining] = removeSessionCredentialMembership([grant], first.sessionId);
    expect(remaining?.members).toEqual([second]);
    expect(remaining?.scm).toEqual(grant.scm);
    expect(remaining?.additionalRepositories).toEqual(grant.additionalRepositories);

    expect(
      removeSessionCredentialMembership(remaining ? [remaining] : [], second.sessionId)
    ).toEqual([]);
  });
});
