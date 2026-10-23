import { describe, expect, it, jest } from '@jest/globals';
import type { resolveGitHubRepositoryForOwner } from '@/lib/slack-bot/github-repository-context';
import type { resolveGitHubIntegrationIdForRepository } from '@/lib/cloud-agent/github-integration-resolution';

type ResolveForOwner = typeof resolveGitHubRepositoryForOwner;
type ResolveIntegrationId = typeof resolveGitHubIntegrationIdForRepository;

// The module under test imports the connection resolver at load time, and this
// suite runs under @swc/jest, which does not move a `jest.mock` factory ahead of
// the static imports. Registering the mock first and requiring the modules
// afterwards is the load boundary that makes the fake authoritative.
jest.mock('@/lib/slack-bot/github-repository-context', () => ({
  resolveGitHubRepositoryForOwner: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mock must be registered before this module loads
const context = require('@/lib/slack-bot/github-repository-context') as {
  resolveGitHubRepositoryForOwner: ResolveForOwner;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mock must be registered before this module loads
const subject = require('@/lib/cloud-agent/github-integration-resolution') as {
  resolveGitHubIntegrationIdForRepository: ResolveIntegrationId;
};

const resolveForOwner = jest.mocked(context.resolveGitHubRepositoryForOwner);
const resolveIntegrationId = subject.resolveGitHubIntegrationIdForRepository;

describe('resolveGitHubIntegrationIdForRepository', () => {
  it('returns the connection that owns the repository for the caller scope', async () => {
    resolveForOwner.mockResolvedValueOnce({
      id: 1,
      name: 'notes',
      full_name: 'acme/notes',
      private: false,
      githubIntegrationId: '123e4567-e89b-12d3-a456-426614174050',
      githubAppType: 'standard',
    });

    await expect(
      resolveIntegrationId({ type: 'user', id: 'user-1' }, 'acme/notes')
    ).resolves.toBe('123e4567-e89b-12d3-a456-426614174050');
    expect(resolveForOwner).toHaveBeenCalledWith(
      { type: 'user', id: 'user-1' },
      'acme/notes',
      'agent'
    );
  });

  it('adds no id when no single connection names the repository', async () => {
    resolveForOwner.mockResolvedValueOnce(null);

    await expect(
      resolveIntegrationId({ type: 'org', id: 'org-1' }, 'acme/notes')
    ).resolves.toBeNull();
  });

  it('stays best effort when the connection read fails', async () => {
    resolveForOwner.mockRejectedValueOnce(new Error('database down'));

    await expect(
      resolveIntegrationId({ type: 'org', id: 'org-1' }, 'acme/notes')
    ).resolves.toBeNull();
  });
});
