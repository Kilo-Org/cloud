import { describe, expect, it } from 'vitest';
import {
  normalizeLegacyGitHubReviewRepository,
  repositoryResourceKey,
  requireLaunchRepository,
  type GitHubUserAuthorization,
  type LaunchRepositoryReference,
  type RepositoryReference,
} from './repository-identity';

const accountId = 'oauth/account';
const reference = {
  repository: {
    provider: 'github',
    instanceUrl: 'https://github.com',
    repositoryId: 'R_123',
    fullName: 'Team/Repo',
    defaultBranch: 'trunk',
  },
  authorization: {
    kind: 'ownerIntegration',
    owner: { type: 'org', id: 'owner' },
    integrationId: 'integration',
  },
} satisfies LaunchRepositoryReference;
const { repository, authorization } = reference;
const userAuthorization: GitHubUserAuthorization = {
  kind: 'githubUser',
  accountId,
  authorizationId: 'authorization',
};
const review = { repository, authorization: userAuthorization };
const key = (value: RepositoryReference, account = accountId) =>
  repositoryResourceKey(account, value);

const variants: Record<string, RepositoryReference> = {
  'authorization kind': review,
  'owner kind': {
    ...reference,
    authorization: { ...authorization, owner: { type: 'user', id: 'owner' } },
  },
  'owner ID': {
    ...reference,
    authorization: { ...authorization, owner: { type: 'org', id: 'OWNER' } },
  },
  integration: { ...reference, authorization: { ...authorization, integrationId: 'other' } },
  provider: { ...reference, repository: { ...repository, provider: 'gitlab' } },
  instance: { ...reference, repository: { ...repository, instanceUrl: 'https://other.example' } },
  'instance subpath': {
    ...reference,
    repository: { ...repository, instanceUrl: 'https://github.com/GitLab' },
  },
  'repository ID': { ...reference, repository: { ...repository, repositoryId: 'r_123' } },
  'repository path': { ...reference, repository: { ...repository, fullName: 'Team/Sub/Repo' } },
};

describe('repository identity isolation', () => {
  it.each(Object.entries(variants))(
    'does not restore a draft from another %s',
    (_name, changed) => {
      expect(new Map([[key(reference), 'saved draft']]).get(key(changed))).toBeUndefined();
    }
  );

  it('isolates the calling account, including case', () => {
    expect(key(reference, 'oauth/ACCOUNT')).not.toBe(key(reference));
  });

  it('canonicalizes the host, default port, trailing slash, and GitHub name case', () => {
    const equivalent = {
      ...reference,
      repository: { ...repository, instanceUrl: 'https://GITHUB.com:443/', fullName: 'team/repo' },
    };
    expect(new Map([[key(reference), 'draft']]).get(key(equivalent))).toBe('draft');
  });

  it('preserves nested GitLab paths and instance subpath case', () => {
    const gitlab = {
      ...reference,
      repository: {
        ...repository,
        provider: 'gitlab',
        instanceUrl: 'https://git.example/GitLab',
        fullName: 'Group/Sub/Repo',
      },
    } satisfies LaunchRepositoryReference;
    for (const changed of [
      { fullName: 'group/sub/repo' },
      { fullName: 'Group/Repo' },
      { instanceUrl: 'https://git.example/gitlab' },
    ]) {
      expect(key({ ...gitlab, repository: { ...gitlab.repository, ...changed } })).not.toBe(
        key(gitlab)
      );
    }
  });

  it('isolates Bitbucket workspace UUIDs, repository UUIDs, and paths', () => {
    const bitbucket = {
      ...reference,
      repository: {
        provider: 'bitbucket',
        instanceUrl: 'https://bitbucket.org',
        workspaceUuid: '{11111111-1111-4111-8111-111111111111}',
        repositoryId: '{22222222-2222-4222-8222-222222222222}',
        fullName: 'Workspace/Repo',
        defaultBranch: null,
      },
    } satisfies LaunchRepositoryReference;
    for (const changed of [
      { workspaceUuid: '{33333333-3333-4333-8333-333333333333}' },
      { repositoryId: '{33333333-3333-4333-8333-333333333333}' },
      { fullName: 'workspace/repo' },
    ]) {
      expect(key({ ...bitbucket, repository: { ...bitbucket.repository, ...changed } })).not.toBe(
        key(bitbucket)
      );
    }
  });

  it('does not collide when delimiters move between components', () => {
    const first = {
      ...reference,
      authorization: {
        ...authorization,
        owner: { ...authorization.owner, id: 'owner:part' },
        integrationId: 'rest/#%"',
      },
    };
    const second = {
      ...reference,
      authorization: { ...authorization, integrationId: 'part:rest/#%"' },
    };
    expect(
      new Map([
        [key(first), 'first'],
        [key(second), 'second'],
      ]).size
    ).toBe(2);
  });

  it('keeps drafts when only default-branch metadata changes', () => {
    expect(key({ ...reference, repository: { ...repository, defaultBranch: null } })).toBe(
      key(reference)
    );
  });

  it.each([
    'invalid',
    'http://git.example',
    'https://user:secret@git.example',
    'https://git.example?query=1',
    'https://git.example#fragment',
  ])('rejects an invalid instance: %s', instanceUrl => {
    expect(() => key({ ...reference, repository: { ...repository, instanceUrl } })).toThrow();
  });
});

describe('legacy GitHub review authorization', () => {
  it.each([
    { installations: [] },
    { installations: ['unrelated-installation', 'another-installation'] },
  ])('resolves user access independently of installations: $installations', context => {
    const input = {
      ...context,
      accountId,
      repository: { repositoryId: 'R_123', fullName: 'Team/Repo' },
      authorization: userAuthorization,
    };
    expect(normalizeLegacyGitHubReviewRepository(input)).toEqual({
      kind: 'resolved',
      reference: {
        repository: { ...repository, defaultBranch: null },
        authorization: userAuthorization,
      },
    });
  });

  it.each([
    { authorization: null, repository },
    { authorization: { ...userAuthorization, accountId: 'another-account' }, repository },
    { authorization: userAuthorization, repository: { fullName: 'Team/Repo' } },
  ])('quarantines unresolved identity without installation fallback: %j', changed => {
    const input = { accountId, ...changed };
    expect(normalizeLegacyGitHubReviewRepository(input)).toEqual({
      kind: 'legacy-unresolved',
      accountId,
      repository: input.repository,
    });
  });

  it('isolates replacement user authorization', () => {
    expect(
      key({ ...review, authorization: { ...userAuthorization, authorizationId: 'replacement' } })
    ).not.toBe(key(review));
  });

  it('rejects a user authorization from another account', () => {
    expect(() => key(review, 'another-account')).toThrow('another account');
  });

  it('rejects user authorization for launch', () => {
    expect(() => requireLaunchRepository(review)).toThrow('ownerIntegration');
  });

  it('preserves the exact owner integration for launch', () => {
    expect(requireLaunchRepository(reference)).toEqual(reference);
  });
});
