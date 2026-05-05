const mockIssuesGetFn = jest.fn();
const mockIssuesListCommentsFn = jest.fn();
const mockGenerateGitHubInstallationTokenFn = jest.fn();

function mockIssuesGet(...args: unknown[]) {
  return mockIssuesGetFn(...args);
}

function mockIssuesListComments(...args: unknown[]) {
  return mockIssuesListCommentsFn(...args);
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
  })),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: mockGenerateGitHubInstallationToken,
}));

import type { Message, Thread } from 'chat';
import type { PlatformIntegration } from '@kilocode/db';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformContext } from './conversation-context';

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

describe('getPlatformContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateGitHubInstallationTokenFn.mockResolvedValue({
      token: 'ghs_test',
      expires_at: 'never',
    });
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
    });

    const context = await getPlatformContext(
      createThread({ id: 'github:Kilo-Org/on-call:issue:37' }),
      createMessage({ id: '101', text: '@kilocode-dev Please fix this' }),
      createIntegration()
    );

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
});
