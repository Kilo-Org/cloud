import { describe, expect, it, beforeEach } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import {
  authorizeOwner,
  authorizeProject,
  classifyGitLabError,
  classifyGitLabStatus,
  GitLabApiStatusError,
  GitLabReviewError,
  type GitLabReviewOwner,
} from './gitlab-authorization';

const mockGetIntegrationForOwner = jest.fn();
const mockGetValidGitLabToken = jest.fn();

/** Await a rejection and return it typed, without a success-branch union. */
async function captureRejection(promise: Promise<unknown>): Promise<GitLabReviewError> {
  try {
    await promise;
  } catch (reason) {
    return reason as GitLabReviewError;
  }
  throw new Error('Expected the call to reject.');
}

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (owner: Owner, platform: string) =>
    mockGetIntegrationForOwner(owner, platform),
}));

jest.mock('@/lib/integrations/gitlab-service', () => ({
  getValidGitLabToken: (
    integration: PlatformIntegration,
    actor: { userId: string; organizationId?: string }
  ) => mockGetValidGitLabToken(integration, actor),
}));

const SELF_MANAGED_USER: GitLabReviewOwner = { type: 'user', userId: 'user_1' };
const SELF_MANAGED_ORG: GitLabReviewOwner = {
  type: 'organization',
  organizationId: 'org_1',
  userId: 'user_1',
};

function integrationRow(overrides: {
  gitlab_instance_url?: string;
  repositories?: { id: number; name: string; full_name: string; private: boolean }[];
  status?: string;
}): PlatformIntegration {
  return {
    id: 'intg_1',
    platform: 'gitlab',
    integration_status: overrides.status ?? 'active',
    owned_by_user_id: 'user_1',
    owned_by_organization_id: null,
    metadata:
      overrides.gitlab_instance_url === undefined
        ? {}
        : { gitlab_instance_url: overrides.gitlab_instance_url },
    repositories: overrides.repositories ?? [
      { id: 7, name: 'repo', full_name: 'group/sub/repo', private: true },
      { id: 8, name: 'other', full_name: 'group/other', private: false },
    ],
  } as unknown as PlatformIntegration;
}

function mockActiveIntegration(integration: PlatformIntegration): void {
  mockGetIntegrationForOwner.mockResolvedValue(integration);
  mockGetValidGitLabToken.mockResolvedValue('glpat-mock-token');
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('authorizeProject — owner resolution', () => {
  it('resolves a user owner through getIntegrationForOwner with the user id', async () => {
    mockActiveIntegration(integrationRow({ gitlab_instance_url: 'https://gitlab.example.com' }));

    const access = await authorizeProject(SELF_MANAGED_USER, 'group/sub/repo');

    expect(mockGetIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: 'user_1' },
      'gitlab'
    );
    expect(mockGetValidGitLabToken).toHaveBeenCalledWith(expect.anything(), { userId: 'user_1' });
    expect(access.accessToken).toBe('glpat-mock-token');
    expect(access.instanceUrl).toBe('https://gitlab.example.com');
    expect(access.projectPath).toBe('group/sub/repo');
  });

  it('resolves an organization owner and passes the acting user to the token broker', async () => {
    mockActiveIntegration(integrationRow({ gitlab_instance_url: 'https://gitlab.example.com' }));

    await authorizeProject(SELF_MANAGED_ORG, 'group/sub/repo');

    expect(mockGetIntegrationForOwner).toHaveBeenCalledWith({ type: 'org', id: 'org_1' }, 'gitlab');
    expect(mockGetValidGitLabToken).toHaveBeenCalledWith(expect.anything(), {
      userId: 'user_1',
      organizationId: 'org_1',
    });
  });

  it('refuses when no integration exists', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(null);

    await expect(authorizeProject(SELF_MANAGED_USER, 'group/sub/repo')).rejects.toMatchObject({
      name: 'GitLabReviewError',
      kind: 'not_found',
      retryable: false,
    });
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
  });

  it('refuses a non-active integration', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(
      integrationRow({ gitlab_instance_url: 'https://gitlab.example.com', status: 'suspended' })
    );

    await expect(authorizeProject(SELF_MANAGED_USER, 'group/sub/repo')).rejects.toBeInstanceOf(
      GitLabReviewError
    );
  });
});

describe('authorizeProject — instance derivation', () => {
  it('derives the instance URL from metadata only', async () => {
    mockActiveIntegration(integrationRow({ gitlab_instance_url: 'https://gitlab.acme.dev/' }));

    const access = await authorizeProject(SELF_MANAGED_USER, 'group/sub/repo');

    expect(access.instanceUrl).toBe('https://gitlab.acme.dev');
  });

  it('defaults to gitlab.com when metadata has no instance URL', async () => {
    mockActiveIntegration(integrationRow({}));

    const access = await authorizeProject(SELF_MANAGED_USER, 'group/sub/repo');

    expect(access.instanceUrl).toBe('https://gitlab.com');
  });

  it('refuses a mismatched instance hint as not_found without resolving a token', async () => {
    mockActiveIntegration(integrationRow({}));

    const error = await captureRejection(
      authorizeProject(SELF_MANAGED_USER, 'group/sub/repo', 'https://gitlab.acme.dev')
    );

    expect(error).toBeInstanceOf(GitLabReviewError);
    expect(error.kind).toBe('not_found');
    expect(error.retryable).toBe(false);
    // The refusal never re-targets: no token is fetched, and the message
    // leaks neither the hint nor the connected host.
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
    expect(error.message).not.toContain('acme.dev');
    expect(error.message).not.toContain('gitlab.com');
  });

  it('accepts a hint whose origin matches the connected instance', async () => {
    mockActiveIntegration(integrationRow({ gitlab_instance_url: 'https://gitlab.example.com' }));

    const access = await authorizeProject(
      SELF_MANAGED_USER,
      'group/sub/repo',
      'https://GitLab.example.com/some/other/path'
    );

    expect(access.instanceUrl).toBe('https://gitlab.example.com');
  });
});

describe('authorizeProject — repository matching', () => {
  it('matches a nested project path case-insensitively end-to-end', async () => {
    mockActiveIntegration(integrationRow({}));

    const access = await authorizeProject(SELF_MANAGED_USER, 'GROUP/Sub/REPO');

    expect(access.projectPath).toBe('group/sub/repo');
  });

  it('refuses a prefix or suffix of a nested path (exact full path only)', async () => {
    mockActiveIntegration(integrationRow({}));

    await expect(authorizeProject(SELF_MANAGED_USER, 'group/sub')).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(authorizeProject(SELF_MANAGED_USER, 'sub/repo')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('refuses a project that is not among the integration repositories', async () => {
    mockActiveIntegration(integrationRow({}));

    await expect(authorizeProject(SELF_MANAGED_USER, 'other/team/repo')).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mockGetValidGitLabToken).not.toHaveBeenCalled();
  });

  it('refuses when the cached repository list is empty', async () => {
    mockActiveIntegration(integrationRow({ repositories: [] }));

    await expect(authorizeProject(SELF_MANAGED_USER, 'group/sub/repo')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });
});

describe('authorizeOwner', () => {
  it('returns token and server-derived instance without a project check', async () => {
    mockActiveIntegration(integrationRow({ gitlab_instance_url: 'https://gitlab.example.com' }));

    const access = await authorizeOwner(SELF_MANAGED_USER);

    expect(access.accessToken).toBe('glpat-mock-token');
    expect(access.instanceUrl).toBe('https://gitlab.example.com');
  });

  it('applies the same instance-hint guard', async () => {
    mockActiveIntegration(integrationRow({ gitlab_instance_url: 'https://gitlab.example.com' }));

    await expect(authorizeOwner(SELF_MANAGED_USER, 'https://gitlab.com')).rejects.toMatchObject({
      kind: 'not_found',
    });
  });
});

describe('credential failures are classified', () => {
  it('maps an expired connection to non-retryable forbidden', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(integrationRow({}));
    mockGetValidGitLabToken.mockRejectedValue(
      new TRPCError({ code: 'UNAUTHORIZED', message: 'reconnect' })
    );

    await expect(authorizeProject(SELF_MANAGED_USER, 'group/sub/repo')).rejects.toMatchObject({
      kind: 'forbidden',
      retryable: false,
    });
  });

  it('maps a temporarily unavailable broker to retryable', async () => {
    mockGetIntegrationForOwner.mockResolvedValue(integrationRow({}));
    mockGetValidGitLabToken.mockRejectedValue(
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'later' })
    );

    await expect(authorizeProject(SELF_MANAGED_USER, 'group/sub/repo')).rejects.toMatchObject({
      kind: 'retryable',
      retryable: true,
    });
  });
});

describe('classifyGitLabStatus / classifyGitLabError', () => {
  it('classifies 404, 403, and 409 as non-retryable kinds', () => {
    expect(classifyGitLabStatus(404).kind).toBe('not_found');
    expect(classifyGitLabStatus(403).kind).toBe('forbidden');
    expect(classifyGitLabStatus(409).kind).toBe('stale_head');
    expect(classifyGitLabStatus(409).retryable).toBe(false);
  });

  it('classifies 5xx and 429 as retryable', () => {
    expect(classifyGitLabStatus(502).retryable).toBe(true);
    expect(classifyGitLabStatus(429).kind).toBe('retryable');
  });

  it('extracts the status from adapter error message tails', () => {
    const classified = classifyGitLabError(new Error('GitLab MR fetch failed: 404'));
    expect(classified.kind).toBe('not_found');
  });

  it('never echoes provider bodies into the classified message', () => {
    const leaked = new GitLabApiStatusError(
      403,
      'GitLab PUT request failed: 403 {"message":"token glpat-secret for https://gitlab.acme.dev denied"}'
    );
    const classified = classifyGitLabError(leaked);
    expect(classified.kind).toBe('forbidden');
    expect(classified.message).not.toContain('glpat-secret');
    expect(classified.message).not.toContain('acme.dev');
  });

  it('classifies network failures as retryable', () => {
    expect(classifyGitLabError(new TypeError('fetch failed')).retryable).toBe(true);
  });
});
