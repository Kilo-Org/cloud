import { getWorkerDb } from '@kilocode/db/client';
import { describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizedGitLabIntegrationQuery,
  GitLabLookupService,
  type GitLabCodeReviewTokenLookupParams,
  type GitLabLookupResult,
} from './gitlab-lookup-service.js';

const params: GitLabCodeReviewTokenLookupParams = {
  userId: 'user_123',
  integrationId: '123e4567-e89b-12d3-a456-426614174011',
  projectId: 42,
};

function createService() {
  return new GitLabLookupService({} as CloudflareEnv);
}

function mockAuthorizedLookup(service: GitLabLookupService, result: GitLabLookupResult) {
  return vi
    .spyOn(
      service as unknown as {
        findAuthorizedGitLabIntegration: (
          input: GitLabCodeReviewTokenLookupParams
        ) => Promise<GitLabLookupResult>;
      },
      'findAuthorizedGitLabIntegration'
    )
    .mockResolvedValue(result);
}

describe('buildAuthorizedGitLabIntegrationQuery', () => {
  const db = getWorkerDb('postgres://unused:unused@localhost:0/unused');

  it('requires the exact personal integration owned by the requesting user', () => {
    const query = buildAuthorizedGitLabIntegrationQuery(db, params).toSQL();

    expect(query.sql).toMatch(/"platform_integrations"\."id" = \$\d+/);
    expect(query.sql).toMatch(/"platform_integrations"\."owned_by_user_id" = \$\d+/);
    expect(query.params).toContain(params.integrationId);
    expect(query.params).toContain(params.userId);
  });

  it('requires organization ownership and membership for organization integrations', () => {
    const orgId = '123e4567-e89b-12d3-a456-426614174022';
    const query = buildAuthorizedGitLabIntegrationQuery(db, { ...params, orgId }).toSQL();

    expect(query.sql).toMatch(/"platform_integrations"\."id" = \$\d+/);
    expect(query.sql).toMatch(/"platform_integrations"\."owned_by_organization_id" = \$\d+::uuid/);
    expect(query.sql).toMatch(/"organization_memberships"\."id" is not null/);
    expect(query.params).toContain(params.integrationId);
    expect(query.params).toContain(orgId);
    expect(query.params).toContain(params.userId);
  });
});

describe('GitLabLookupService.findGitLabCodeReviewToken', () => {
  it('returns the stored project token from the requested authorized integration', async () => {
    const service = createService();
    const authorizedLookup = mockAuthorizedLookup(service, {
      success: true,
      integrationId: params.integrationId,
      metadata: {
        access_token: 'human-integration-token',
        project_tokens: {
          '42': { token: 'project-bot-token' },
        },
      },
    });

    await expect(service.findGitLabCodeReviewToken(params)).resolves.toEqual({
      success: true,
      token: 'project-bot-token',
      instanceUrl: 'https://gitlab.com',
    });
    expect(authorizedLookup).toHaveBeenCalledWith(params);
  });

  it('does not fall back to the integration token when the requested project token is missing', async () => {
    const service = createService();
    mockAuthorizedLookup(service, {
      success: true,
      integrationId: params.integrationId,
      metadata: {
        access_token: 'human-integration-token',
        project_tokens: {
          '43': { token: 'other-project-token' },
        },
      },
    });

    await expect(service.findGitLabCodeReviewToken(params)).resolves.toEqual({
      success: false,
      reason: 'no_project_token',
    });
  });

  it('preserves authorization failures for an unowned integration', async () => {
    const service = createService();
    mockAuthorizedLookup(service, { success: false, reason: 'no_integration_found' });

    await expect(service.findGitLabCodeReviewToken(params)).resolves.toEqual({
      success: false,
      reason: 'no_integration_found',
    });
  });

  it('rejects malformed selectors before attempting authorized integration lookup', async () => {
    const service = createService();
    const authorizedLookup = mockAuthorizedLookup(service, {
      success: false,
      reason: 'no_integration_found',
    });

    await expect(
      service.findGitLabCodeReviewToken({ ...params, integrationId: 'not-a-uuid' })
    ).resolves.toEqual({ success: false, reason: 'invalid_integration_id' });
    await expect(service.findGitLabCodeReviewToken({ ...params, projectId: 0 })).resolves.toEqual({
      success: false,
      reason: 'invalid_project_id',
    });
    expect(authorizedLookup).not.toHaveBeenCalled();
  });
});
