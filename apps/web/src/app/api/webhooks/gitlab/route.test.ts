const mockFindGitLabIntegrationByWebhookToken = jest.fn();
const mockVerifyGitLabWebhookToken = jest.fn();
const mockHandleGitLabNoteBotMention = jest.fn();
const mockHandleMergeRequest = jest.fn();
const mockLogWebhookEvent = jest.fn();
const mockUpdateWebhookEvent = jest.fn();

let afterCallbacks: Array<() => Promise<void> | void> = [];

jest.mock('next/server', () => {
  const actual = jest.requireActual('next/server');
  return {
    ...actual,
    after: (fn: () => Promise<void> | void) => {
      afterCallbacks.push(fn);
    },
  };
});

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  verifyGitLabWebhookToken: (...args: unknown[]) => mockVerifyGitLabWebhookToken(...args),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  findGitLabIntegrationByWebhookToken: (...args: unknown[]) =>
    mockFindGitLabIntegrationByWebhookToken(...args),
}));

jest.mock('@/lib/integrations/platforms/gitlab/webhook-handlers', () => ({
  handleGitLabNoteBotMention: (...args: unknown[]) => mockHandleGitLabNoteBotMention(...args),
  handleMergeRequest: (...args: unknown[]) => mockHandleMergeRequest(...args),
}));

jest.mock('@/lib/integrations/db/webhook-events', () => ({
  logWebhookEvent: (...args: unknown[]) => mockLogWebhookEvent(...args),
  updateWebhookEvent: (...args: unknown[]) => mockUpdateWebhookEvent(...args),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { POST } from './route';

function gitLabRequest(payload: unknown): Request {
  return new Request('https://app.example.com/api/webhooks/gitlab', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-gitlab-token': 'secret',
      'x-gitlab-event': 'Note Hook',
      'x-gitlab-event-uuid': 'event-1',
    },
    body: JSON.stringify(payload),
  });
}

function createIntegration() {
  return {
    id: 'pi_gitlab_1',
    owned_by_user_id: 'user_1',
    owned_by_organization_id: null,
    platform: 'gitlab',
    metadata: { webhook_secret: 'secret', bot_enabled: true },
    suspended_at: null,
  };
}

function createNotePayload(note: string, overrides: Record<string, unknown> = {}) {
  return {
    object_kind: 'note',
    event_type: 'note',
    user: { id: 123, name: 'RSO', username: 'rso' },
    project_id: 456,
    project: {
      id: 456,
      name: 'widgets',
      web_url: 'https://gitlab.example.com/acme/widgets',
      namespace: 'acme',
      path_with_namespace: 'acme/widgets',
      default_branch: 'main',
    },
    object_attributes: {
      id: 789,
      note,
      noteable_type: 'MergeRequest',
      author_id: 123,
      created_at: '2026-05-05T07:32:52Z',
      updated_at: '2026-05-05T07:32:52Z',
      project_id: 456,
      noteable_id: 999,
      noteable_iid: 37,
      system: false,
      url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/37#note_789',
      ...overrides,
    },
    merge_request: {
      id: 999,
      iid: 37,
      title: 'Update widgets',
      description: 'MR description',
      state: 'opened',
      source_branch: 'feature/widgets',
      target_branch: 'main',
      source_project_id: 456,
      target_project_id: 456,
      author_id: 123,
      created_at: '2026-05-05T07:00:00Z',
      updated_at: '2026-05-05T07:00:00Z',
      url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/37',
    },
  };
}

async function flushAfterCallbacks(): Promise<void> {
  const callbacks = afterCallbacks;
  afterCallbacks = [];
  await Promise.all(callbacks.map(callback => callback()));
}

describe('GitLab webhook route', () => {
  beforeEach(() => {
    afterCallbacks = [];
    jest.clearAllMocks();
    mockFindGitLabIntegrationByWebhookToken.mockResolvedValue(createIntegration());
    mockVerifyGitLabWebhookToken.mockReturnValue(true);
    mockLogWebhookEvent.mockResolvedValue({ id: 'webhook_event_1', isDuplicate: false });
    mockHandleGitLabNoteBotMention.mockResolvedValue(undefined);
  });

  it('ignores MR notes without a Kilo bot mention', async () => {
    const response = await POST(gitLabRequest(createNotePayload('please fix this')) as never);
    await flushAfterCallbacks();

    expect(response.status).toBe(200);
    expect(mockLogWebhookEvent).not.toHaveBeenCalled();
    expect(mockHandleGitLabNoteBotMention).not.toHaveBeenCalled();
  });

  it('schedules bot mention handling for MR notes that mention Kilo', async () => {
    const payload = createNotePayload('@kilocode-bot open a new MR for this');
    const integration = createIntegration();
    mockFindGitLabIntegrationByWebhookToken.mockResolvedValue(integration);

    const response = await POST(gitLabRequest(payload) as never);
    await flushAfterCallbacks();

    expect(response.status).toBe(200);
    expect(mockLogWebhookEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_action: 'bot_mention' })
    );
    expect(mockHandleGitLabNoteBotMention).toHaveBeenCalledWith(payload, integration);
    expect(mockUpdateWebhookEvent).toHaveBeenCalledWith(
      'webhook_event_1',
      expect.objectContaining({ processed: true, handlers_triggered: ['bot_mention'] })
    );
  });

  it('ignores system notes', async () => {
    const response = await POST(
      gitLabRequest(createNotePayload('@kilocode-bot fix this', { system: true })) as never
    );
    await flushAfterCallbacks();

    expect(response.status).toBe(200);
    expect(mockHandleGitLabNoteBotMention).not.toHaveBeenCalled();
  });
});
