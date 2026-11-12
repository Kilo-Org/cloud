import {
  createProjectWebhook,
  deleteProjectWebhook,
  findKiloWebhook,
  GitLabAuthenticationError,
  GitLabWebhookPermissionError,
  type GitLabWebhook,
} from './adapter';
import { syncWebhooksForRepositories } from './webhook-sync';

jest.mock('./adapter', () => ({
  ...jest.requireActual('./adapter'),
  findKiloWebhook: jest.fn(),
  createProjectWebhook: jest.fn(),
  updateProjectWebhook: jest.fn(),
  deleteProjectWebhook: jest.fn(),
}));

const mockFindKiloWebhook = jest.mocked(findKiloWebhook);
const mockCreateProjectWebhook = jest.mocked(createProjectWebhook);
const mockDeleteProjectWebhook = jest.mocked(deleteProjectWebhook);

function makeWebhook(id: number, projectId: number): GitLabWebhook {
  return {
    id,
    url: 'https://app.kilo.ai/api/webhooks/gitlab',
    project_id: projectId,
    push_events: true,
    push_events_branch_filter: '',
    issues_events: false,
    confidential_issues_events: false,
    merge_requests_events: true,
    tag_push_events: false,
    note_events: true,
    confidential_note_events: false,
    job_events: false,
    pipeline_events: false,
    wiki_page_events: false,
    deployment_events: false,
    releases_events: false,
    subgroup_events: false,
    member_events: false,
    enable_ssl_verification: true,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('syncWebhooksForRepositories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindKiloWebhook.mockResolvedValue(null);
  });

  it('attempts a selected repository that has no recorded webhook, even when it is already selected', async () => {
    mockCreateProjectWebhook.mockResolvedValueOnce(makeWebhook(9001, 123));

    const { result, updatedWebhooks } = await syncWebhooksForRepositories(
      'token',
      'webhook-secret',
      [123],
      [123],
      {}
    );

    // The earlier create failed, so nothing is recorded for 123: the next save
    // that carries the same selection must try again.
    expect(mockCreateProjectWebhook).toHaveBeenCalledTimes(1);
    expect(result.created).toEqual([{ projectId: 123, hookId: 9001 }]);
    expect(result.errors).toEqual([]);
    const recorded = updatedWebhooks[String(123)];
    expect(recorded?.hook_id).toBe(9001);
    expect(recorded?.created_at).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
  });

  it('leaves a selected repository alone when its recorded webhook is already stored', async () => {
    const { result } = await syncWebhooksForRepositories('token', 'webhook-secret', [123], [123], {
      '123': { hook_id: 42, created_at: '2025-12-01T00:00:00.000Z' },
    });

    expect(mockCreateProjectWebhook).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('still deletes a repository dropped from the selection', async () => {
    mockDeleteProjectWebhook.mockResolvedValueOnce(undefined);

    const { result, updatedWebhooks } = await syncWebhooksForRepositories(
      'token',
      'webhook-secret',
      [],
      [123],
      { '123': { hook_id: 42, created_at: '2025-12-01T00:00:00.000Z' } }
    );

    expect(mockDeleteProjectWebhook).toHaveBeenCalledTimes(1);
    expect(result.deleted).toEqual([{ projectId: 123, hookId: 42 }]);
    expect(updatedWebhooks).toEqual({});
  });

  it('asks the user to reconnect when GitLab rejects the credential', async () => {
    mockCreateProjectWebhook.mockRejectedValueOnce(
      new GitLabAuthenticationError(
        123,
        401,
        'GitLab rejected the credential while creating a webhook for project 123 (HTTP 401). Reconnect the GitLab integration and try again.'
      )
    );

    const { result, updatedWebhooks } = await syncWebhooksForRepositories(
      'token',
      'webhook-secret',
      [123],
      [],
      {}
    );

    expect(result.created).toEqual([]);
    expect(result.errors).toEqual([
      {
        projectId: 123,
        operation: 'create',
        error:
          'GitLab rejected the connected credential: reconnect the GitLab integration, then retry. You can still configure the webhook manually in GitLab.',
      },
    ]);
    expect(updatedWebhooks).toEqual({});
  });

  it('keeps Maintainer-role guidance when GitLab refuses the role', async () => {
    mockCreateProjectWebhook.mockRejectedValueOnce(
      new GitLabWebhookPermissionError(
        123,
        403,
        'Insufficient permissions to create webhook for project 123. Requires Maintainer role or higher.'
      )
    );

    const { result } = await syncWebhooksForRepositories('token', 'webhook-secret', [123], [], {});

    expect(result.errors).toEqual([
      {
        projectId: 123,
        operation: 'create',
        error:
          'Permission denied: You need Maintainer role or higher on this project to configure webhooks automatically. You can still configure the webhook manually in GitLab.',
      },
    ]);
  });
});
