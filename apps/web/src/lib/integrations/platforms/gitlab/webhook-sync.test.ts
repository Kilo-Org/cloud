import {
  createProjectWebhook,
  deleteProjectWebhook,
  findKiloWebhook,
  GitLabAuthenticationError,
  GitLabWebhookPermissionError,
  type GitLabWebhook,
} from './adapter';
import { rotationRepositorySelection, syncWebhooksForRepositories } from './webhook-sync';

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
    expect(mockDeleteProjectWebhook).not.toHaveBeenCalled();
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

  it('a delete failure keeps the stored handle and reports its hook id', async () => {
    mockDeleteProjectWebhook.mockRejectedValueOnce(new Error('GitLab delete webhook failed: 403'));

    const { result, updatedWebhooks } = await syncWebhooksForRepositories(
      'token',
      'webhook-secret',
      [],
      [123],
      { '123': { hook_id: 42, created_at: '2025-12-01T00:00:00.000Z' } }
    );

    expect(result.deleted).toEqual([]);
    expect(result.errors).toEqual([
      {
        projectId: 123,
        operation: 'delete',
        hookId: 42,
        error: expect.stringContaining('403'),
      },
    ]);
    expect(updatedWebhooks['123']).toEqual({
      hook_id: 42,
      created_at: '2025-12-01T00:00:00.000Z',
    });
  });

  it('asks the user to reconnect when a delete is refused for the credential', async () => {
    mockDeleteProjectWebhook.mockRejectedValueOnce(
      new GitLabAuthenticationError(
        123,
        401,
        'GitLab rejected the credential while deleting a webhook for project 123 (HTTP 401). Reconnect the GitLab integration and try again.'
      )
    );

    const { result, updatedWebhooks } = await syncWebhooksForRepositories(
      'token',
      'webhook-secret',
      [],
      [123],
      { '123': { hook_id: 42, created_at: '2025-12-01T00:00:00.000Z' } }
    );

    expect(result.deleted).toEqual([]);
    expect(result.errors).toEqual([
      {
        projectId: 123,
        operation: 'delete',
        hookId: 42,
        error:
          'GitLab rejected the connected credential: reconnect the GitLab integration, then retry. You can still configure the webhook manually in GitLab.',
      },
    ]);
    expect(updatedWebhooks['123']).toEqual({
      hook_id: 42,
      created_at: '2025-12-01T00:00:00.000Z',
    });
  });

  it('keeps Maintainer-role guidance when a delete is refused for the role', async () => {
    mockDeleteProjectWebhook.mockRejectedValueOnce(
      new GitLabWebhookPermissionError(
        123,
        403,
        'Insufficient permissions to delete webhook for project 123. Requires Maintainer role or higher.'
      )
    );

    const { result } = await syncWebhooksForRepositories('token', 'webhook-secret', [], [123], {
      '123': { hook_id: 42, created_at: '2025-12-01T00:00:00.000Z' },
    });

    expect(result.errors).toEqual([
      {
        projectId: 123,
        operation: 'delete',
        hookId: 42,
        error:
          'Permission denied: You need Maintainer role or higher on this project to configure webhooks automatically. You can still configure the webhook manually in GitLab.',
      },
    ]);
  });

  it('a later save retries the kept removal when only the stored map names the project', async () => {
    mockDeleteProjectWebhook.mockResolvedValueOnce(undefined);

    const { result, updatedWebhooks } = await syncWebhooksForRepositories(
      'token',
      'webhook-secret',
      [],
      [],
      { '123': { hook_id: 42, created_at: '2025-12-01T00:00:00.000Z' } }
    );

    expect(mockDeleteProjectWebhook).toHaveBeenCalledTimes(1);
    expect(mockDeleteProjectWebhook).toHaveBeenCalledWith('token', 123, 42, 'https://gitlab.com');
    expect(result.deleted).toEqual([{ projectId: 123, hookId: 42 }]);
    expect(result.errors).toEqual([]);
    expect(updatedWebhooks).toEqual({});
  });

  it('a resolved removal drops the entry', async () => {
    mockDeleteProjectWebhook.mockResolvedValueOnce(undefined);

    const { result, updatedWebhooks } = await syncWebhooksForRepositories(
      'token',
      'webhook-secret',
      [],
      [],
      { '123': { hook_id: 42, created_at: '2025-12-01T00:00:00.000Z' } }
    );

    expect(updatedWebhooks['123']).toBeUndefined();
    expect(result.deleted).toEqual([{ projectId: 123, hookId: 42 }]);
  });

  it('a stored entry for a project that stays selected is never deleted', async () => {
    const stored = { hook_id: 42, created_at: '2025-12-01T00:00:00.000Z' };

    const { updatedWebhooks } = await syncWebhooksForRepositories(
      'token',
      'webhook-secret',
      [123],
      [123],
      { '123': stored }
    );

    expect(mockDeleteProjectWebhook).not.toHaveBeenCalled();
    expect(updatedWebhooks['123']).toEqual(stored);
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

describe('rotationRepositorySelection', () => {
  const storedWebhooks: Record<string, { hook_id: number; created_at: string }> = {
    '123': { hook_id: 42, created_at: '2025-12-01T00:00:00.000Z' },
    '456': { hook_id: 43, created_at: '2025-12-02T00:00:00.000Z' },
    '789': { hook_id: 44, created_at: '2025-12-03T00:00:00.000Z' },
  };

  it('rotates every stored hook when no stored selection is available', () => {
    expect(rotationRepositorySelection(storedWebhooks, undefined)).toEqual([123, 456, 789]);
  });

  it('rotates only the stored hooks the selection names, in the given order', () => {
    expect(rotationRepositorySelection(storedWebhooks, [789, 123])).toEqual([789, 123]);
  });

  it('falls back to every stored hook when the selection names only unstored projects', () => {
    expect(rotationRepositorySelection(storedWebhooks, [111, 222])).toEqual([123, 456, 789]);
  });

  it('falls back to every stored hook when the selection is empty', () => {
    expect(rotationRepositorySelection(storedWebhooks, [])).toEqual([123, 456, 789]);
  });

  it('ignores a stored key that is not a project id', () => {
    const withUnusableKey = { ...storedWebhooks, 'not-a-project': storedWebhooks['123'] };

    expect(rotationRepositorySelection(withUnusableKey, undefined)).toEqual([123, 456, 789]);
  });
});
