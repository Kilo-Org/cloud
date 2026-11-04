const mockIntegrations = jest.fn();
const mockRows = jest.fn();
const mockLock = jest.fn();
const mockUpdate = jest.fn();
const mockAuthorize = jest.fn();
const mockTransaction = jest.fn();
const mockTx = {
  select: () => ({
    from: () => ({
      where: (condition: unknown) => {
        mockRows(condition);
        return { for: mockLock };
      },
    }),
  }),
  update: () => ({
    set: (value: unknown) => ({ where: (condition: unknown) => mockUpdate(value, condition) }),
  }),
};
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    select: () => ({ from: () => ({ where: mockIntegrations }) }),
    transaction: (callback: (tx: typeof mockTx) => Promise<void>) => mockTransaction(callback),
  },
}));
jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: (...args: unknown[]) => mockAuthorize(...args),
  GitHubRuntimeAuthorizationError: class extends Error {},
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { GitHubRuntimeAuthorizationError } from '@/lib/integrations/github/runtime-authorization';
import { observePrWebhook } from './pr-observations-webhook';
import { getPrObservationSummary } from './pr-observations';
const head = 'a'.repeat(40);
const payload = {
  installation: { id: 10 },
  repository: { id: 20, full_name: 'owner/repo' },
  id: 100,
  sha: head,
  context: 'test',
  state: 'failure',
  updated_at: '2026-10-21T12:00:00Z',
};
const integration = {
  id: 'integration-1',
  owned_by_user_id: 'oauth/user',
  owned_by_organization_id: null,
  repository_access: 'selected',
  repositories: [{ id: 20, full_name: 'owner/repo' }],
};
const cache = {
  git_url: 'https://github.com/owner/repo',
  pr_number: 7,
  pr_head_sha: head,
  pr_observations: null,
};
const input = { eventType: 'status', payload, appType: 'standard' as const };
describe('passive PR webhook observer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIntegrations.mockResolvedValue([integration]);
    mockLock.mockResolvedValue([cache]);
    mockAuthorize.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(undefined);
    mockTransaction.mockImplementation(callback => callback(mockTx));
  });
  it('authorizes the association and locks tenant/repository-scoped rows', async () => {
    await observePrWebhook(input);
    expect(mockAuthorize).toHaveBeenCalledWith('10', 'standard', 'integration-1', 'agent');
    expect(mockLock).toHaveBeenCalledWith('update');
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const [value, condition] = mockUpdate.mock.calls[0];
    expect(getPrObservationSummary(value.pr_observations, head)?.checks).toEqual({
      total: 1,
      failed: 1,
    });
    const query = new PgDialect().sqlToQuery(condition);
    expect(query.params).toEqual(
      expect.arrayContaining(['oauth/user', 'https://github.com/owner/repo', 7])
    );
    expect(query.sql).toContain('"owned_by_organization_id" is null');
    expect(new PgDialect().sqlToQuery(mockRows.mock.calls[0][0]).params).toContain(head);
  });
  it('observes every separately authorized shared-installation tenant', async () => {
    mockIntegrations.mockResolvedValue([
      integration,
      {
        ...integration,
        id: 'integration-2',
        owned_by_user_id: null,
        owned_by_organization_id: 'org-2',
      },
    ]);
    await observePrWebhook(input);
    expect(mockAuthorize).toHaveBeenCalledTimes(2);
    expect(mockUpdate).toHaveBeenCalledTimes(2);
    expect(new PgDialect().sqlToQuery(mockUpdate.mock.calls[1][1]).params).toContain('org-2');
  });
  it('rejects repository ID/name mismatches and unavailable associations', async () => {
    mockIntegrations.mockResolvedValue([
      { ...integration, repositories: [{ id: 21, full_name: 'owner/repo' }] },
    ]);
    await observePrWebhook(input);
    expect(mockAuthorize).not.toHaveBeenCalled();
    mockIntegrations.mockResolvedValue([
      { ...integration, repositories: [{ id: 20, full_name: 'other/repo' }] },
    ]);
    await observePrWebhook(input);
    expect(mockAuthorize).not.toHaveBeenCalled();
    mockIntegrations.mockResolvedValue([integration]);
    mockAuthorize.mockRejectedValueOnce(new GitHubRuntimeAuthorizationError());
    await observePrWebhook(input);
    expect(mockTransaction).not.toHaveBeenCalled();
  });
  it('never creates cache records or processes unrelated events', async () => {
    mockLock.mockResolvedValue([]);
    await observePrWebhook(input);
    expect(mockUpdate).not.toHaveBeenCalled();
    jest.clearAllMocks();
    await observePrWebhook({ ...input, eventType: 'issue_comment' });
    expect(mockIntegrations).not.toHaveBeenCalled();
  });
  it('propagates transient failures for webhook retry', async () => {
    mockAuthorize.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(observePrWebhook(input)).rejects.toThrow('database unavailable');
    mockUpdate.mockRejectedValueOnce(new Error('write failed'));
    await expect(observePrWebhook(input)).rejects.toThrow('write failed');
  });
});
