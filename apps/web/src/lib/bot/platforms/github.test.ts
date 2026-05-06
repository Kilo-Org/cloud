const mockIssuesGetFn = jest.fn();
const mockIssuesListCommentsFn = jest.fn();
const mockPullsListReviewCommentsFn = jest.fn();
const mockGenerateGitHubInstallationTokenFn = jest.fn();

function mockIssuesGet(...args: unknown[]) {
  return mockIssuesGetFn(...args);
}

function mockIssuesListComments(...args: unknown[]) {
  return mockIssuesListCommentsFn(...args);
}

function mockPullsListReviewComments(...args: unknown[]) {
  return mockPullsListReviewCommentsFn(...args);
}

function mockGenerateGitHubInstallationToken(...args: unknown[]) {
  return mockGenerateGitHubInstallationTokenFn(...args);
}

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    issues: {
      get: mockIssuesGet,
      listComments: mockIssuesListComments,
    },
    pulls: {
      listReviewComments: mockPullsListReviewComments,
    },
  })),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: mockGenerateGitHubInstallationToken,
}));

import type { Message, Thread } from 'chat';
import type { PlatformIntegration } from '@kilocode/db';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  createGitHubBotPlatform,
  getGitHubRepositoryReference,
  isGitHubRepositoryLinked,
} from './github';

const githubPlatform = createGitHubBotPlatform({
  getInstallationId: jest.fn(),
});

function createMessage(params: { id: string; text: string; author?: string }): Message {
  return {
    id: params.id,
    threadId: 'github:Kilo-Org/on-call:issue:37',
    text: params.text,
    formatted: { type: 'root', children: [] },
    raw: {},
    author: {
      fullName: params.author ?? 'RSO',
      isBot: false,
      isMe: false,
      userId: '123',
      userName: params.author ?? 'RSO',
    },
    metadata: {
      dateSent: new Date('2026-05-05T07:32:52Z'),
      edited: false,
    },
    attachments: [],
    links: [],
    toJSON: () => {
      throw new Error('not implemented');
    },
  };
}

async function* messages(items: Message[]): AsyncIterable<Message> {
  for (const item of items) yield item;
}

function createThread(params: { id: string; threadMessages?: Message[] }): Thread {
  return {
    id: params.id,
    adapter: { name: 'github' },
    isDM: false,
    channel: {
      fetchMetadata: async () => ({
        id: 'github:Kilo-Org/on-call',
        isDM: false,
        metadata: {},
        name: 'Kilo-Org/on-call',
      }),
      get messages() {
        return messages([]);
      },
    },
    get messages() {
      return messages(params.threadMessages ?? []);
    },
  } as Thread;
}

function createIntegration(overrides: Partial<PlatformIntegration> = {}): PlatformIntegration {
  return {
    id: 'pi_1',
    owned_by_organization_id: 'org_1',
    owned_by_user_id: null,
    created_by_user_id: 'user_1',
    platform: PLATFORM.GITHUB,
    integration_type: 'app',
    platform_installation_id: '98765',
    platform_account_id: '123',
    platform_account_login: 'Kilo-Org',
    permissions: null,
    scopes: null,
    repository_access: 'all',
    repositories: null,
    repositories_synced_at: null,
    metadata: null,
    kilo_requester_user_id: null,
    platform_requester_account_id: null,
    integration_status: 'active',
    suspended_at: null,
    suspended_by: null,
    github_app_type: 'standard',
    installed_at: '2026-05-05T07:00:00Z',
    created_at: '2026-05-05T07:00:00Z',
    updated_at: '2026-05-05T07:00:00Z',
    ...overrides,
  };
}

describe('createGitHubBotPlatform.isEnabledForBot', () => {
  function integrationWithMetadata(metadata: PlatformIntegration['metadata']): PlatformIntegration {
    return { metadata } as PlatformIntegration;
  }

  it('returns true only when metadata.bot_enabled is the boolean true', () => {
    expect(githubPlatform.isEnabledForBot(integrationWithMetadata({ bot_enabled: true }))).toBe(
      true
    );
  });

  it('returns false when metadata is missing the flag', () => {
    expect(githubPlatform.isEnabledForBot(integrationWithMetadata({}))).toBe(false);
    expect(githubPlatform.isEnabledForBot(integrationWithMetadata(null))).toBe(false);
  });

  it('returns false for truthy non-boolean values to avoid accidental enables', () => {
    expect(githubPlatform.isEnabledForBot(integrationWithMetadata({ bot_enabled: 'true' }))).toBe(
      false
    );
    expect(githubPlatform.isEnabledForBot(integrationWithMetadata({ bot_enabled: 1 }))).toBe(false);
  });

  it('returns false when explicitly disabled', () => {
    expect(githubPlatform.isEnabledForBot(integrationWithMetadata({ bot_enabled: false }))).toBe(
      false
    );
  });
});

describe('getGitHubRepositoryReference', () => {
  it('uses GitHub webhook repository metadata when available', () => {
    const reference = getGitHubRepositoryReference(
      {
        adapter: { name: PLATFORM.GITHUB },
        channelId: 'github:acme/fallback',
        id: 'github:acme/fallback:42',
      } as Thread,
      {
        raw: {
          repository: {
            id: 123,
            full_name: 'acme/widgets',
          },
        },
      } as Message
    );

    expect(reference).toEqual({ id: 123, fullName: 'acme/widgets' });
  });

  it('falls back to the repository encoded in the GitHub thread id', () => {
    const reference = getGitHubRepositoryReference(
      {
        adapter: { name: PLATFORM.GITHUB },
        channelId: 'github:acme/widgets',
        id: 'github:acme/widgets:issue:42',
      } as Thread,
      { raw: {} } as Message
    );

    expect(reference).toEqual({ id: null, fullName: 'acme/widgets' });
  });

  it('falls back to the repository encoded in the GitHub channel id', () => {
    const reference = getGitHubRepositoryReference(
      {
        adapter: { name: PLATFORM.GITHUB },
        channelId: 'github:acme/widgets',
        id: 'github:malformed',
      } as Thread,
      { raw: {} } as Message
    );

    expect(reference).toEqual({ id: null, fullName: 'acme/widgets' });
  });
});

describe('isGitHubRepositoryLinked', () => {
  function integrationWithRepositoryAccess(
    repositoryAccess: PlatformIntegration['repository_access'],
    repositories: PlatformIntegration['repositories']
  ): PlatformIntegration {
    return { repository_access: repositoryAccess, repositories } as PlatformIntegration;
  }

  const selectedIntegration = integrationWithRepositoryAccess('selected', [
    { id: 123, name: 'widgets', full_name: 'acme/widgets', private: true },
  ]);

  it('allows all repositories when the integration has all repository access', () => {
    const integration = integrationWithRepositoryAccess('all', null);

    expect(isGitHubRepositoryLinked(integration, { id: null, fullName: 'acme/widgets' })).toBe(
      true
    );
  });

  it('allows selected repositories by id', () => {
    expect(isGitHubRepositoryLinked(selectedIntegration, { id: 123, fullName: null })).toBe(true);
  });

  it('allows selected repositories by case-insensitive full name', () => {
    expect(
      isGitHubRepositoryLinked(selectedIntegration, { id: null, fullName: 'ACME/Widgets' })
    ).toBe(true);
  });

  it('blocks repositories not selected for the installation', () => {
    expect(isGitHubRepositoryLinked(selectedIntegration, { id: 456, fullName: 'acme/other' })).toBe(
      false
    );
  });

  it('blocks when repository access has not been synced yet', () => {
    const integration = integrationWithRepositoryAccess(null, null);

    expect(isGitHubRepositoryLinked(integration, { id: 123, fullName: 'acme/widgets' })).toBe(
      false
    );
  });

  it('blocks when the repository cannot be identified', () => {
    const integration = integrationWithRepositoryAccess('all', null);

    expect(isGitHubRepositoryLinked(integration, { id: null, fullName: null })).toBe(false);
  });
});

describe('createGitHubBotPlatform.getConversationContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateGitHubInstallationTokenFn.mockResolvedValue({
      token: 'ghs_test',
      expires_at: 'never',
    });
    mockPullsListReviewCommentsFn.mockResolvedValue({ data: [], headers: {} });
  });

  it('returns GitHub issue context with repository, description, history, and triggering comment', async () => {
    mockIssuesGetFn.mockResolvedValue({
      data: {
        body: 'Delete the obsolete operational-retro runbook from the repository.',
        html_url: 'https://github.com/Kilo-Org/on-call/issues/37',
        number: 37,
        state: 'open',
        title: 'Remove operational-retro runbook',
        user: { login: 'RSO' },
      },
    });
    mockIssuesListCommentsFn.mockResolvedValue({
      data: [
        {
          id: 100,
          body: 'This runbook is no longer referenced by incident response.',
          created_at: '2026-05-05T07:20:00Z',
          user: { login: 'alice' },
        },
        {
          id: 101,
          body: '@kilocode-dev Please fix this',
          created_at: '2026-05-05T07:32:52Z',
          user: { login: 'RSO' },
        },
      ],
      headers: {},
    });

    const context = await githubPlatform.getConversationContext({
      thread: createThread({ id: 'github:Kilo-Org/on-call:issue:37' }),
      triggerMessage: createMessage({ id: '101', text: '@kilocode-dev Please fix this' }),
      platformIntegration: createIntegration(),
    });

    expect(context).toContain('GitHub context:');
    expect(context).toContain('- Repository: Kilo-Org/on-call');
    expect(context).not.toContain('Channel: #Kilo-Org/on-call');
    expect(context).toContain('- Issue: #37 Remove operational-retro runbook');
    expect(context).toContain('Issue description:');
    expect(context).toContain('Delete the obsolete operational-retro runbook from the repository.');
    expect(context).toContain('Existing GitHub conversation comments (oldest first):');
    expect(context).toContain('This runbook is no longer referenced by incident response.');
    expect(context).not.toContain('<github_comment id="101"');
    expect(context).toContain('Comment that triggered this bot run:');
    expect(context).toContain('@kilocode-dev Please fix this');
  });

  it('fetches only the newest issue comments in a single request', async () => {
    mockIssuesGetFn.mockResolvedValue({
      data: {
        body: 'Issue description.',
        html_url: 'https://github.com/Kilo-Org/on-call/issues/37',
        number: 37,
        state: 'open',
        title: 'Remove operational-retro runbook',
        user: { login: 'RSO' },
      },
    });
    mockIssuesListCommentsFn.mockResolvedValue({
      data: [
        {
          id: 200,
          body: 'most recent context',
          created_at: '2026-05-05T07:30:00Z',
          user: { login: 'alice' },
        },
        {
          id: 199,
          body: 'previous context',
          created_at: '2026-05-05T07:29:00Z',
          user: { login: 'bob' },
        },
      ],
      headers: {},
    });

    const context = await githubPlatform.getConversationContext({
      thread: createThread({ id: 'github:Kilo-Org/on-call:issue:37' }),
      triggerMessage: createMessage({ id: '201', text: '@kilocode-dev Please fix this' }),
      platformIntegration: createIntegration(),
    });

    expect(mockIssuesListCommentsFn).toHaveBeenCalledTimes(1);
    expect(mockIssuesListCommentsFn).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: 'created',
        direction: 'desc',
        per_page: 12,
      })
    );

    const previousIndex = context.indexOf('previous context');
    const recentIndex = context.indexOf('most recent context');
    expect(previousIndex).toBeGreaterThan(-1);
    expect(recentIndex).toBeGreaterThan(previousIndex);
  });

  it('caps pull request review comment pagination to avoid hammering the GitHub API', async () => {
    mockIssuesGetFn.mockResolvedValue({
      data: {
        body: 'Pull request description.',
        html_url: 'https://github.com/Kilo-Org/on-call/pull/37',
        number: 37,
        pull_request: {},
        state: 'open',
        title: 'Update on-call runbook',
        user: { login: 'RSO' },
      },
    });
    mockIssuesListCommentsFn.mockResolvedValue({ data: [], headers: {} });
    mockPullsListReviewCommentsFn.mockImplementation(({ page }: { page: number }) => ({
      data: [],
      headers: {
        link: `<https://api.github.com/repos/Kilo-Org/on-call/pulls/37/comments?page=${page + 1}>; rel="next"`,
      },
    }));

    await githubPlatform.getConversationContext({
      thread: createThread({ id: 'github:Kilo-Org/on-call:37:rc:301' }),
      triggerMessage: createMessage({ id: '301', text: '@kilocode-dev Please fix this' }),
      platformIntegration: createIntegration(),
    });

    expect(mockPullsListReviewCommentsFn).toHaveBeenCalledTimes(5);
  });

  it('includes GitHub pull request review thread context', async () => {
    mockIssuesGetFn.mockResolvedValue({
      data: {
        body: 'Pull request description.',
        html_url: 'https://github.com/Kilo-Org/on-call/pull/37',
        number: 37,
        pull_request: {},
        state: 'open',
        title: 'Update on-call runbook',
        user: { login: 'RSO' },
      },
    });
    mockIssuesListCommentsFn.mockResolvedValue({ data: [], headers: {} });
    mockPullsListReviewCommentsFn.mockResolvedValue({
      data: [
        {
          id: 300,
          body: 'This conditional is wrong.',
          created_at: '2026-05-05T07:20:00Z',
          diff_hunk: '@@ -10,7 +10,7 @@\n- old\n+ new',
          html_url: 'https://github.com/Kilo-Org/on-call/pull/37#discussion_r300',
          line: 12,
          path: 'src/on-call.ts',
          user: { login: 'alice' },
        },
        {
          id: 301,
          body: '@kilocode-dev Please fix this',
          created_at: '2026-05-05T07:32:52Z',
          in_reply_to_id: 300,
          line: 12,
          path: 'src/on-call.ts',
          user: { login: 'RSO' },
        },
      ],
      headers: {},
    });

    const context = await githubPlatform.getConversationContext({
      thread: createThread({ id: 'github:Kilo-Org/on-call:37:rc:301' }),
      triggerMessage: createMessage({ id: '301', text: '@kilocode-dev Please fix this' }),
      platformIntegration: createIntegration(),
    });

    expect(context).toContain('Pull request review thread:');
    expect(context).toContain('- File: src/on-call.ts');
    expect(context).toContain('- Line: 12');
    expect(context).toContain('github_diff_hunk');
    expect(context).toContain('This conditional is wrong.');
    expect(context).not.toContain('<github_review_comment id="301"');
    expect(context).toContain('Comment that triggered this bot run:');
  });
});
