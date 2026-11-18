const mockFindGitLabIntegrationByWebhookToken = jest.fn();
const mockHandleMergeRequest = jest.fn();
const mockLogWebhookEvent = jest.fn();
const mockUpdateWebhookEvent = jest.fn();
const mockVerifyGitLabWebhookToken = jest.fn();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  findGitLabIntegrationByWebhookToken: (token: string) =>
    mockFindGitLabIntegrationByWebhookToken(token),
}));

jest.mock('@/lib/integrations/platforms/gitlab/webhook-handlers', () => ({
  handleMergeRequest: (payload: unknown, integration: unknown) =>
    mockHandleMergeRequest(payload, integration),
}));

jest.mock('@/lib/integrations/db/webhook-events', () => ({
  logWebhookEvent: (input: unknown) => mockLogWebhookEvent(input),
  updateWebhookEvent: (id: string, input: unknown) => mockUpdateWebhookEvent(id, input),
}));

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  verifyGitLabWebhookToken: (token: string, expected?: string) =>
    mockVerifyGitLabWebhookToken(token, expected),
}));

import { NextRequest } from 'next/server';
import { POST } from './route';
import type { GitLabWebhookIntegration } from '@/lib/integrations/db/platform-integrations';

const WEBHOOK_SECRET = 'test-webhook-secret';

function mergeRequestPayload() {
  return {
    object_kind: 'merge_request',
    event_type: 'merge_request',
    user: { id: 1, name: 'Dev', username: 'dev' },
    project: {
      id: 123,
      name: 'repo',
      namespace: 'group/sub',
      path_with_namespace: 'group/sub/repo',
      web_url: 'https://gitlab.com/group/sub/repo',
      default_branch: 'main',
    },
    object_attributes: {
      id: 91,
      iid: 7,
      action: 'open',
      state: 'opened',
      title: 'Add widget endpoint',
      source_branch: 'feature/widget',
      target_branch: 'main',
      source_project_id: 123,
      target_project_id: 123,
      author_id: 1,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      url: 'https://gitlab.com/group/sub/repo/-/merge_requests/7',
      last_commit: { id: 'a'.repeat(40), message: 'widget' },
    },
  };
}

function integration(overrides: Partial<GitLabWebhookIntegration> = {}): GitLabWebhookIntegration {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    owned_by_organization_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    owned_by_user_id: null,
    kilo_requester_user_id: 'user-1',
    integration_status: 'active',
    suspended_at: null,
    webhook_secret: WEBHOOK_SECRET,
    ...overrides,
  };
}

function gitlabRequest(token: string | null, body: unknown = mergeRequestPayload()): NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set('x-gitlab-event', 'Merge Request Hook');
  headers.set('x-gitlab-event-uuid', 'event-uuid-1');
  if (token !== null) headers.set('x-gitlab-token', token);
  return new NextRequest('https://app.example.com/api/webhooks/gitlab', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('GitLab webhook route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyGitLabWebhookToken.mockReturnValue(true);
    mockLogWebhookEvent.mockResolvedValue({ id: 'event-1', isDuplicate: false });
    mockHandleMergeRequest.mockResolvedValue(
      Response.json({ message: 'Code review queued', reviewId: 'review-1' }, { status: 202 })
    );
  });

  it('processes a delivery for an active integration', async () => {
    const row = integration();
    mockFindGitLabIntegrationByWebhookToken.mockResolvedValue(row);

    const response = await POST(gitlabRequest(WEBHOOK_SECRET));

    expect(response.status).toBe(202);
    expect(mockHandleMergeRequest).toHaveBeenCalledTimes(1);
    expect(mockHandleMergeRequest).toHaveBeenCalledWith(expect.anything(), row);
    expect(mockLogWebhookEvent).toHaveBeenCalledTimes(1);
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith('event-1', {
      processed: true,
      processed_at: expect.any(String),
      handlers_triggered: ['code_review'],
      errors: null,
    });
  });

  it('acknowledges a delivery when the integration is inactive by status', async () => {
    // An integration recorded as inactive by status, with no suspension timestamp.
    mockFindGitLabIntegrationByWebhookToken.mockResolvedValue(
      integration({ integration_status: 'suspended', suspended_at: null })
    );

    const response = await POST(gitlabRequest(WEBHOOK_SECRET));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ message: 'Integration suspended' });
    expect(mockHandleMergeRequest).not.toHaveBeenCalled();
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
    expect(mockUpdateWebhookEvent).not.toHaveBeenCalled();
  });

  it('acknowledges a delivery for an integration suspended by timestamp', async () => {
    mockFindGitLabIntegrationByWebhookToken.mockResolvedValue(
      integration({ integration_status: 'active', suspended_at: '2026-01-01T00:00:00.000+00' })
    );

    const response = await POST(gitlabRequest(WEBHOOK_SECRET));

    expect(response.status).toBe(200);
    expect(mockHandleMergeRequest).not.toHaveBeenCalled();
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
  });

  it('acknowledges a delivery when the integration is not yet active', async () => {
    mockFindGitLabIntegrationByWebhookToken.mockResolvedValue(
      integration({ integration_status: 'pending' })
    );

    const response = await POST(gitlabRequest(WEBHOOK_SECRET));

    expect(response.status).toBe(200);
    expect(mockHandleMergeRequest).not.toHaveBeenCalled();
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects an unknown webhook token', async () => {
    mockFindGitLabIntegrationByWebhookToken.mockResolvedValue(null);

    const response = await POST(gitlabRequest('unknown-secret'));

    expect(response.status).toBe(401);
    expect(mockVerifyGitLabWebhookToken).not.toHaveBeenCalled();
    expect(mockHandleMergeRequest).not.toHaveBeenCalled();
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects a delivery without the token header', async () => {
    const response = await POST(gitlabRequest(null));

    expect(response.status).toBe(401);
    expect(mockFindGitLabIntegrationByWebhookToken).not.toHaveBeenCalled();
    expect(mockHandleMergeRequest).not.toHaveBeenCalled();
  });

  it('rejects a delivery whose token fails the constant-time comparison', async () => {
    mockFindGitLabIntegrationByWebhookToken.mockResolvedValue(integration());
    mockVerifyGitLabWebhookToken.mockReturnValue(false);

    const response = await POST(gitlabRequest(WEBHOOK_SECRET));

    expect(response.status).toBe(401);
    expect(mockHandleMergeRequest).not.toHaveBeenCalled();
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
  });
});
