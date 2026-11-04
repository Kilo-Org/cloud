import {
  createProjectWebhook,
  findKiloWebhook,
  GitLabAuthenticationError,
  GitLabWebhookPermissionError,
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

describe('syncWebhooksForRepositories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindKiloWebhook.mockResolvedValue(null);
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
