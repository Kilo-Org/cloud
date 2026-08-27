import { describe, expect, it } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  buildGastownRepositoryRigInput,
  findGastownRepository,
  GastownRepositoryOptionLabel,
  gastownRepositoryKey,
  getGastownRepositoryDiscriminator,
  groupGastownRepositories,
  type GastownRepositoryOption,
} from './GastownRepositorySelector';

const firstIntegrationId = '11111111-1111-4111-8111-111111111111';
const secondIntegrationId = '22222222-2222-4222-8222-222222222222';

function githubRepository(
  overrides: Partial<GastownRepositoryOption> = {}
): GastownRepositoryOption {
  return {
    id: 101,
    fullName: 'acme/widgets',
    private: true,
    platform: 'github',
    defaultBranch: 'trunk',
    platformIntegrationId: firstIntegrationId,
    platformAccountLogin: 'acme',
    ...overrides,
  };
}

describe('Gastown onboarding repository selection', () => {
  it('restores the exact GitHub installation and preserves its rig provenance', () => {
    const first = githubRepository();
    const duplicate = githubRepository({ platformIntegrationId: secondIntegrationId });

    const selected = findGastownRepository([first, duplicate], gastownRepositoryKey(duplicate));

    expect(selected).toMatchObject({
      fullName: 'acme/widgets',
      defaultBranch: 'trunk',
      platformIntegrationId: secondIntegrationId,
    });
    expect(
      selected && buildGastownRepositoryRigInput(selected, undefined, [first, duplicate])
    ).toEqual({
      gitUrl: 'https://github.com/acme/widgets.git',
      defaultBranch: 'trunk',
      platformIntegrationId: secondIntegrationId,
    });
    expect(gastownRepositoryKey(first)).not.toBe(gastownRepositoryKey(duplicate));
  });
});

describe('Gastown later rig repository selection', () => {
  it('omits the integration ID for authoritative resolution of a unique repository', () => {
    const selected = findGastownRepository(
      [githubRepository()],
      gastownRepositoryKey(githubRepository())
    );

    expect(selected && buildGastownRepositoryRigInput(selected)).toEqual({
      gitUrl: 'https://github.com/acme/widgets.git',
      defaultBranch: 'trunk',
    });
  });

  it('rejects a stale selection after its repository option disappears', () => {
    const staleKey = gastownRepositoryKey(githubRepository());

    expect(findGastownRepository([], staleKey)).toBeNull();
    expect(
      findGastownRepository(
        [githubRepository({ platformIntegrationId: secondIntegrationId })],
        staleKey
      )
    ).toBeNull();
  });
});

describe('Gastown GitHub repository grouping', () => {
  it('groups GitHub repositories by organization and distinguishes duplicate rows', () => {
    const repositories = [
      githubRepository(),
      githubRepository({ platformIntegrationId: secondIntegrationId }),
      githubRepository({
        id: 202,
        fullName: 'octo/api',
        platformIntegrationId: '33333333-3333-4333-8333-333333333333',
        platformAccountLogin: 'octo',
      }),
    ];

    expect(
      groupGastownRepositories(repositories).map(group => ({
        label: group.label,
        repositories: group.repositories.map(repository => repository.fullName),
      }))
    ).toEqual([
      { label: 'acme', repositories: ['acme/widgets', 'acme/widgets'] },
      { label: 'octo', repositories: ['octo/api'] },
    ]);

    const duplicateNames = new Set(['acme/widgets']);
    expect(getGastownRepositoryDiscriminator(repositories[0], duplicateNames)).toBe(
      `Connection ${firstIntegrationId}`
    );
    expect(getGastownRepositoryDiscriminator(repositories[1], duplicateNames)).toBe(
      `Connection ${secondIntegrationId}`
    );
    expect(getGastownRepositoryDiscriminator(repositories[2], duplicateNames)).toBeNull();
  });
});

describe('Gastown repository labels', () => {
  it('bounds long labels while retaining the full repository name', () => {
    const fullName = `organization-with-a-long-name/${'repository-segment-'.repeat(8)}`;
    const html = renderToStaticMarkup(
      createElement(GastownRepositoryOptionLabel, {
        repository: githubRepository({ fullName }),
        discriminator: `Connection ${firstIntegrationId}`,
      })
    );

    expect(html).toContain('class="truncate font-mono"');
    expect(html).toContain(`title="${fullName}"`);
    expect(html).toContain(fullName);
    expect(html).toContain(`Connection ${firstIntegrationId}`);
  });
});
