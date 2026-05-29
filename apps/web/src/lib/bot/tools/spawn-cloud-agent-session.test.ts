import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db';
import type { CloudAgentAttachments } from '@/lib/cloud-agent/constants';
import type { createCloudAgentNextClient as CreateCloudAgentNextClient } from '@/lib/cloud-agent-next/cloud-agent-client';
import type { getGitHubTokenForUser as GetGitHubTokenForUser } from '@/lib/cloud-agent/github-integration-helpers';
import type {
  buildGitLabCloneUrl as BuildGitLabCloneUrl,
  getGitLabInstanceUrlForUser as GetGitLabInstanceUrlForUser,
  getGitLabTokenForUser as GetGitLabTokenForUser,
} from '@/lib/cloud-agent/gitlab-integration-helpers';
import type { resolveBotSessionProfile as ResolveBotSessionProfile } from './resolve-bot-session-profile';
import type SpawnCloudAgentSession from './spawn-cloud-agent-session';

jest.mock('@/lib/config.server', () => ({
  CALLBACK_TOKEN_SECRET: 'callback-secret',
}));

jest.mock('@/lib/constants', () => ({
  APP_URL: 'https://app.example.test',
}));

jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  createCloudAgentNextClient: jest.fn(),
}));

jest.mock('@/lib/cloud-agent/github-integration-helpers', () => ({
  getGitHubTokenForOrganization: jest.fn(),
  getGitHubTokenForUser: jest.fn(),
}));

jest.mock('@/lib/cloud-agent/gitlab-integration-helpers', () => ({
  getGitLabTokenForOrganization: jest.fn(),
  getGitLabTokenForUser: jest.fn(),
  getGitLabInstanceUrlForOrganization: jest.fn(),
  getGitLabInstanceUrlForUser: jest.fn(),
  buildGitLabCloneUrl: jest.fn(),
}));

jest.mock('./resolve-bot-session-profile', () => ({
  resolveBotSessionProfile: jest.fn(),
}));

jest.mock('@kilocode/cloud-agent-profile', () => ({
  profileMcpServersToClientRecord: jest.fn(() => undefined),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

const platformIntegration = {
  owned_by_organization_id: null,
  owned_by_user_id: 'owner-1',
} as PlatformIntegration;
const attachments: CloudAgentAttachments = {
  path: 'message-attachments',
  files: ['image.png', 'requirements.md'],
};

const mockPrepareSession =
  jest.fn<(input: unknown) => Promise<{ cloudAgentSessionId: string; kiloSessionId: string }>>();
const mockInitiateFromPreparedSession = jest.fn<(input: unknown) => Promise<unknown>>();
let spawnCloudAgentSession: typeof SpawnCloudAgentSession;
let mockCreateCloudAgentNextClient: jest.MockedFunction<typeof CreateCloudAgentNextClient>;
let mockGetGitHubTokenForUser: jest.MockedFunction<typeof GetGitHubTokenForUser>;
let mockGetGitLabTokenForUser: jest.MockedFunction<typeof GetGitLabTokenForUser>;
let mockGetGitLabInstanceUrlForUser: jest.MockedFunction<typeof GetGitLabInstanceUrlForUser>;
let mockBuildGitLabCloneUrl: jest.MockedFunction<typeof BuildGitLabCloneUrl>;
let mockResolveBotSessionProfile: jest.MockedFunction<typeof ResolveBotSessionProfile>;

describe('spawnCloudAgentSession attachment forwarding', () => {
  beforeAll(async () => {
    const client = await import('@/lib/cloud-agent-next/cloud-agent-client');
    const github = await import('@/lib/cloud-agent/github-integration-helpers');
    const gitlab = await import('@/lib/cloud-agent/gitlab-integration-helpers');
    const profile = await import('./resolve-bot-session-profile');
    const spawn = await import('./spawn-cloud-agent-session');

    mockCreateCloudAgentNextClient = jest.mocked(client.createCloudAgentNextClient);
    mockGetGitHubTokenForUser = jest.mocked(github.getGitHubTokenForUser);
    mockGetGitLabTokenForUser = jest.mocked(gitlab.getGitLabTokenForUser);
    mockGetGitLabInstanceUrlForUser = jest.mocked(gitlab.getGitLabInstanceUrlForUser);
    mockBuildGitLabCloneUrl = jest.mocked(gitlab.buildGitLabCloneUrl);
    mockResolveBotSessionProfile = jest.mocked(profile.resolveBotSessionProfile);
    spawnCloudAgentSession = spawn.default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateCloudAgentNextClient.mockReturnValue({
      prepareSession: mockPrepareSession,
      initiateFromPreparedSession: mockInitiateFromPreparedSession,
    } as never);
    mockPrepareSession.mockResolvedValue({
      cloudAgentSessionId: 'cloud-session-1',
      kiloSessionId: 'kilo-session-1',
    });
    mockInitiateFromPreparedSession.mockResolvedValue({});
    mockResolveBotSessionProfile.mockResolvedValue({});
    mockGetGitHubTokenForUser.mockResolvedValue('github-token');
    mockGetGitLabTokenForUser.mockResolvedValue('gitlab-token');
    mockGetGitLabInstanceUrlForUser.mockResolvedValue('https://gitlab.com');
    mockBuildGitLabCloneUrl.mockReturnValue('https://gitlab.com/group/repo.git');
  });

  it('passes only canonical attachments when preparing a GitHub session', async () => {
    await spawnCloudAgentSession(
      { githubRepo: 'owner/repo', prompt: 'Use the files', mode: 'code' },
      'model',
      platformIntegration,
      'auth-token',
      'ticket-user',
      'request-1',
      undefined,
      { attachments }
    );

    const prepareInput = mockPrepareSession.mock.calls[0]?.[0];
    expect(prepareInput).toEqual(expect.objectContaining({ attachments }));
    expect(prepareInput).not.toHaveProperty('images');
  });

  it('passes only canonical attachments when preparing a GitLab session', async () => {
    await spawnCloudAgentSession(
      { gitlabProject: 'group/repo', prompt: 'Use the files', mode: 'ask' },
      'model',
      platformIntegration,
      'auth-token',
      'ticket-user',
      'request-2',
      undefined,
      { attachments }
    );

    const prepareInput = mockPrepareSession.mock.calls[0]?.[0];
    expect(prepareInput).toEqual(expect.objectContaining({ attachments }));
    expect(prepareInput).not.toHaveProperty('images');
  });
});
