import { getWorkerDb } from '@kilocode/db/client';
import { describe, expect, it } from 'vitest';
import {
  buildAuthorizedGitLabIntegrationQuery,
  isValidGitLabRepositoryUrl,
  matchGitLabRepositoryToIntegration,
  type AuthorizedGitLabIntegration,
} from './gitlab-lookup-service.js';

const params = { userId: 'user_123' };

function integration(
  instanceUrl = 'https://gitlab.com',
  integrationId = '123e4567-e89b-12d3-a456-426614174011'
): AuthorizedGitLabIntegration {
  return {
    integrationId,
    metadata: { gitlab_instance_url: instanceUrl },
  };
}

describe('buildAuthorizedGitLabIntegrationQuery', () => {
  const db = getWorkerDb('postgres://unused:unused@localhost:0/unused');

  it('requires an active personal integration owned by the requesting user', () => {
    const query = buildAuthorizedGitLabIntegrationQuery(db, params).toSQL();

    expect(query.sql).toMatch(/"platform_integrations"\."owned_by_user_id" = \$\d+/);
    expect(query.sql).not.toMatch(/"platform_integrations"\."id" = \$\d+/);
    expect(query.sql.toLowerCase()).not.toContain('limit');
    expect(query.params).toContain(params.userId);
  });

  it('requires organization ownership and membership for organization integrations', () => {
    const orgId = '123e4567-e89b-12d3-a456-426614174022';
    const query = buildAuthorizedGitLabIntegrationQuery(db, { ...params, orgId }).toSQL();

    expect(query.sql).toMatch(/"platform_integrations"\."owned_by_organization_id" = \$\d+::uuid/);
    expect(query.sql).toMatch(/"organization_memberships"\."id" is not null/);
    expect(query.params).toContain(orgId);
    expect(query.params).toContain(params.userId);
  });
});

describe('matchGitLabRepositoryToIntegration', () => {
  it('extracts a GitLab.com project path', () => {
    expect(
      matchGitLabRepositoryToIntegration('https://gitlab.com/acme/repo.git', integration())
    ).toMatchObject({ instanceUrl: 'https://gitlab.com', projectPath: 'acme/repo' });
  });

  it('extracts a project path below a self-hosted instance base path', () => {
    expect(
      matchGitLabRepositoryToIntegration(
        'https://gitlab.example.com/gitlab/platform/backend.git',
        integration('https://gitlab.example.com/gitlab/')
      )
    ).toMatchObject({
      instanceUrl: 'https://gitlab.example.com/gitlab',
      projectPath: 'platform/backend',
    });
    expect(
      matchGitLabRepositoryToIntegration(
        'https://gitlab.example.com/gitlab//platform/backend.git',
        integration('https://gitlab.example.com/gitlab/')
      )
    ).toMatchObject({ projectPath: 'platform/backend' });
  });

  it('does not match another instance or a base-path prefix collision', () => {
    expect(
      matchGitLabRepositoryToIntegration(
        'https://gitlab-b.example.com/acme/repo.git',
        integration('https://gitlab-a.example.com')
      )
    ).toBeNull();
    expect(
      matchGitLabRepositoryToIntegration(
        'https://gitlab.example.com/gitlab-other/acme/repo.git',
        integration('https://gitlab.example.com/gitlab')
      )
    ).toBeNull();
  });

  it('rejects malformed, credential-bearing, and UI repository URLs', () => {
    expect(isValidGitLabRepositoryUrl('not a url')).toBe(false);
    expect(
      matchGitLabRepositoryToIntegration('https://token@gitlab.com/acme/repo.git', integration())
    ).toBeNull();
    expect(
      matchGitLabRepositoryToIntegration(
        'https://gitlab.com/acme/repo/-/merge_requests/1',
        integration()
      )
    ).toBeNull();
  });
});
