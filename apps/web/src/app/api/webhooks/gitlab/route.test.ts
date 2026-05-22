import type { NextRequest } from 'next/server';

const mockVerifyGitLabWebhookToken = jest.fn((_token: string, _expected?: string) => true);
const mockFindGitLabIntegrationByWebhookToken = jest.fn();
const mockHandleMergeRequest = jest.fn();
const mockLogWebhookEvent = jest.fn();
const mockUpdateWebhookEvent = jest.fn();
const mockHandleGitLabEmojiFeedback = jest.fn();
const mockHandleGitLabMergeRequestFeedback = jest.fn();
const mockHandleGitLabNoteFeedback = jest.fn();

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  verifyGitLabWebhookToken: (token: string, expected?: string) =>
    mockVerifyGitLabWebhookToken(token, expected),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  findGitLabIntegrationByWebhookToken: (token: string) =>
    mockFindGitLabIntegrationByWebhookToken(token),
}));

jest.mock('@/lib/integrations/platforms/gitlab/webhook-handlers', () => ({
  handleMergeRequest: (payload: unknown, integration: unknown) =>
    mockHandleMergeRequest(payload, integration),
}));

jest.mock('@/lib/integrations/db/webhook-events', () => ({
  logWebhookEvent: (data: unknown) => mockLogWebhookEvent(data),
  updateWebhookEvent: (eventId: string, updates: unknown) =>
    mockUpdateWebhookEvent(eventId, updates),
}));

jest.mock('@/lib/code-reviews/review-memory/gitlab-feedback', () => ({
  handleGitLabEmojiFeedback: (input: unknown) => mockHandleGitLabEmojiFeedback(input),
  handleGitLabMergeRequestFeedback: (input: unknown) => mockHandleGitLabMergeRequestFeedback(input),
  handleGitLabNoteFeedback: (input: unknown) => mockHandleGitLabNoteFeedback(input),
}));

import { POST } from './route';

const integration = {
  id: 'pi_gitlab',
  owned_by_organization_id: 'org_1',
  owned_by_user_id: null,
  suspended_at: null,
  metadata: { webhook_secret: 'secret' },
};

function gitLabRequest(eventType: string, payload: unknown): NextRequest {
  return new Request('https://app.example.com/api/webhooks/gitlab', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitlab-token': 'secret',
      'x-gitlab-event': eventType,
      'x-gitlab-event-uuid': `delivery-${eventType}`,
    },
    body: JSON.stringify(payload),
  }) as NextRequest;
}

function user() {
  return { id: 7, name: 'Maintainer', username: 'maintainer' };
}

function project() {
  return {
    id: 123,
    name: 'widgets',
    web_url: 'https://gitlab.example.com/acme/widgets',
    namespace: 'acme',
    path_with_namespace: 'acme/widgets',
    default_branch: 'main',
  };
}

function mergeRequestAttributes(overrides: Record<string, unknown> = {}) {
  return {
    id: 900,
    iid: 42,
    title: 'Add widgets',
    state: 'opened',
    action: 'update',
    source_branch: 'feature/widgets',
    target_branch: 'main',
    source_project_id: 123,
    target_project_id: 123,
    author_id: 7,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:01:00.000Z',
    url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42',
    last_commit: {
      id: 'abc123',
      message: 'Add widgets',
    },
    ...overrides,
  };
}

function mergeRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: 'merge_request',
    event_type: 'merge_request',
    user: user(),
    project: project(),
    object_attributes: mergeRequestAttributes(),
    ...overrides,
  };
}

function notePayload(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: 'note',
    event_type: 'note',
    user: user(),
    project_id: 123,
    project: project(),
    object_attributes: {
      id: 501,
      note: 'This is a false positive.',
      action: 'create',
      discussion_id: 'discussion-1',
      noteable_type: 'MergeRequest',
      author_id: 7,
      created_at: '2026-01-01T00:02:00.000Z',
      updated_at: '2026-01-01T00:02:00.000Z',
      project_id: 123,
      system: false,
      url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42#note_501',
    },
    merge_request: mergeRequestAttributes(),
    ...overrides,
  };
}

function emojiPayload(overrides: Record<string, unknown> = {}) {
  return {
    object_kind: 'emoji',
    event_type: 'emoji',
    user: user(),
    project_id: 123,
    project: project(),
    object_attributes: {
      id: 777,
      name: 'thumbsdown',
      action: 'award',
      awardable_type: 'Note',
      awardable_id: 500,
      created_at: '2026-01-01T00:02:00.000Z',
    },
    merge_request: mergeRequestAttributes(),
    note: {
      id: 500,
      note: '**WARNING**: Avoid this pattern',
      url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/42#note_500',
      noteable_type: 'MergeRequest',
    },
    ...overrides,
  };
}

describe('GitLab webhook route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyGitLabWebhookToken.mockReturnValue(true);
    mockFindGitLabIntegrationByWebhookToken.mockResolvedValue(integration);
    mockHandleMergeRequest.mockResolvedValue(Response.json({ message: 'Event received' }));
    mockLogWebhookEvent.mockResolvedValue({ id: 'we_1', isDuplicate: false });
    mockUpdateWebhookEvent.mockResolvedValue(undefined);
    mockHandleGitLabEmojiFeedback.mockResolvedValue({ recorded: true, eventIds: ['event_1'] });
    mockHandleGitLabMergeRequestFeedback.mockResolvedValue({
      recorded: true,
      eventIds: ['event_1'],
    });
    mockHandleGitLabNoteFeedback.mockResolvedValue({ recorded: true, eventIds: ['event_1'] });
  });

  it('routes merge request events to code review and review memory feedback', async () => {
    const response = await POST(gitLabRequest('Merge Request Hook', mergeRequestPayload()));

    expect(response.status).toBe(200);
    expect(mockHandleMergeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ object_kind: 'merge_request' }),
      integration
    );
    expect(mockHandleGitLabMergeRequestFeedback).toHaveBeenCalledWith({
      payload: expect.objectContaining({ object_kind: 'merge_request' }),
      integration,
      deliveryId: 'delivery-Merge Request Hook',
    });
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'we_1',
      expect.objectContaining({ handlers_triggered: ['code_review', 'review_memory_feedback'] })
    );
  });

  it('routes note events to review memory feedback', async () => {
    const response = await POST(gitLabRequest('Note Hook', notePayload()));

    expect(response.status).toBe(200);
    expect(mockHandleMergeRequest).not.toHaveBeenCalled();
    expect(mockHandleGitLabNoteFeedback).toHaveBeenCalledWith({
      payload: expect.objectContaining({ object_kind: 'note' }),
      integration,
      deliveryId: 'delivery-Note Hook',
    });
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'we_1',
      expect.objectContaining({ handlers_triggered: ['review_memory_feedback'] })
    );
  });

  it('routes emoji events to review memory feedback', async () => {
    const response = await POST(gitLabRequest('Emoji Hook', emojiPayload()));

    expect(response.status).toBe(200);
    expect(mockHandleMergeRequest).not.toHaveBeenCalled();
    expect(mockHandleGitLabEmojiFeedback).toHaveBeenCalledWith({
      payload: expect.objectContaining({ object_kind: 'emoji' }),
      integration,
      deliveryId: 'delivery-Emoji Hook',
    });
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'we_1',
      expect.objectContaining({ handlers_triggered: ['review_memory_feedback'] })
    );
  });
});
