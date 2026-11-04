import { describe, expect, it } from 'vitest';
import type { EnvironmentReference } from '@kilocode/cloud-agent-profile';
import { sessionReferenceOf } from '../../environment-build/reference.js';
import { assertRequestedRepositories } from './requested-environment-repositories.js';

const launch = { platform: 'github' as const, repoFullName: 'acme/api' };
const environment: EnvironmentReference = {
  environmentId: '11111111-1111-4111-8111-111111111111',
  owner: { type: 'user', id: 'user-1' },
  configurationRevision: 2,
  repositories: [
    { identity: launch, repoFullName: 'acme/api', leaf: 'api' },
    {
      identity: { platform: 'github', repoFullName: 'acme/web' },
      repoFullName: 'acme/web',
      leaf: 'web',
    },
  ],
};

describe('requested entry to repository match', () => {
  // The same entry goes through the preflight check and then through the
  // session reference. Preflight accepts an entry exactly when the reference
  // gives its repository the requested branch.
  it.each([
    { entry: 'acme/web', accepted: true },
    { entry: 'Acme/Web', accepted: true },
    { entry: ' acme/web ', accepted: true },
    { entry: 'acme/web/', accepted: false },
    { entry: 'acme/web.git', accepted: false },
    { entry: 'acme/other', accepted: false },
  ])('agrees on "$entry"', ({ entry, accepted }) => {
    const requested = {
      id: environment.environmentId,
      repositories: [{ repoFullName: entry, branch: 'feature/x' }],
    };
    const check = () => assertRequestedRepositories({ environment, launch, requested });

    if (!accepted) {
      expect(check).toThrow(entry);
      return;
    }
    check();
    const reference = sessionReferenceOf(environment, {
      generatedBranch: 'kilo/generated',
      launch,
      launchBranch: undefined,
      requested: requested.repositories,
    });
    expect(reference.repositories?.map(repository => repository.branch)).toEqual([
      'kilo/generated',
      'feature/x',
    ]);
  });

  it('rejects the launch repository, a repeated entry, and a V1 environment, naming the repository', () => {
    const named = (repoFullName: string) => ({
      id: environment.environmentId,
      repositories: [{ repoFullName }],
    });
    expect(() =>
      assertRequestedRepositories({ environment, launch, requested: named('Acme/API') })
    ).toThrow('Acme/API');
    expect(() =>
      assertRequestedRepositories({
        environment,
        launch,
        requested: {
          id: environment.environmentId,
          repositories: [{ repoFullName: 'acme/web' }, { repoFullName: 'ACME/web' }],
        },
      })
    ).toThrow('ACME/web');
    const v1: EnvironmentReference = {
      environmentId: environment.environmentId,
      owner: environment.owner,
      configurationRevision: 1,
      repository: launch,
    };
    expect(() =>
      assertRequestedRepositories({ environment: v1, launch, requested: named('acme/web') })
    ).toThrow('acme/web');
  });
});
