const mockGetCollaboratorPermissionLevelFn = jest.fn();

function mockGetCollaboratorPermissionLevel(...args: unknown[]) {
  return mockGetCollaboratorPermissionLevelFn(...args);
}

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  getCollaboratorPermissionLevel: mockGetCollaboratorPermissionLevel,
}));

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(async () => undefined),
}));

import type { Message, Thread } from 'chat';
import type { PlatformIntegration } from '@kilocode/db';
import { createGitHubBotPlatform } from './github';

const githubPlatform = createGitHubBotPlatform({ getInstallationId: jest.fn() });

function createMessage(params: { id: string; text: string; login?: string }): Message {
  return {
    id: params.id,
    threadId: 'github:Kilo-Org/on-call:issue:37',
    text: params.text,
    formatted: { type: 'root', children: [] },
    raw: {
      repository: { full_name: 'Kilo-Org/on-call' },
    },
    author: {
      fullName: params.login ?? 'RSO',
      isBot: false,
      isMe: false,
      userId: '123',
      userName: params.login ?? 'RSO',
    },
    metadata: {
      dateSent: new Date('2026-05-05T07:32:52Z'),
      edited: false,
    },
    attachments: [],
    links: [],
    subject: Promise.resolve(null),
    toJSON: () => {
      throw new Error('not implemented');
    },
  } as unknown as Message;
}

function createThread(id: string): Thread {
  return {
    id,
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
        return (async function* () {})();
      },
    },
    get messages() {
      return (async function* () {})();
    },
  } as unknown as Thread;
}

function createIntegration(overrides: Partial<PlatformIntegration> = {}): PlatformIntegration {
  return {
    id: 'pi_1',
    owned_by_organization_id: 'org_1',
    owned_by_user_id: null,
    platform: 'github',
    platform_installation_id: '98765',
    github_app_type: 'standard',
    repository_access: 'all',
    repositories: null,
    ...overrides,
  } as PlatformIntegration;
}

beforeEach(() => {
  mockGetCollaboratorPermissionLevelFn.mockReset();
});

describe('createGitHubBotPlatform.authorizeBotActions', () => {
  it('looks up the triggering account on the linked repository', async () => {
    mockGetCollaboratorPermissionLevelFn.mockResolvedValue('write');

    const result = await githubPlatform.authorizeBotActions!({
      thread: createThread('github:Kilo-Org/on-call:issue:37'),
      message: createMessage({ id: '11', text: '@kilocode-dev please fix', login: 'rso-dev' }),
      platformIntegration: createIntegration(),
    });

    expect(result).toEqual({ allowed: true });
    expect(mockGetCollaboratorPermissionLevelFn).toHaveBeenCalledWith(
      '98765',
      'Kilo-Org',
      'on-call',
      'rso-dev',
      'standard',
      'pi_1'
    );
  });

  it('refuses a read-only commenter', async () => {
    mockGetCollaboratorPermissionLevelFn.mockResolvedValue('read');

    const result = await githubPlatform.authorizeBotActions!({
      thread: createThread('github:Kilo-Org/read-only:issue:7'),
      message: createMessage({
        id: '12',
        text: '@kilocode-dev please fix',
        login: 'reader-account',
      }),
      platformIntegration: createIntegration(),
    });

    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ markdown: expect.stringContaining('write access') });
  });

  it('allows a personally owned integration without a permission lookup', async () => {
    const result = await githubPlatform.authorizeBotActions!({
      thread: createThread('github:Kilo-Org/on-call:issue:37'),
      message: createMessage({ id: '13', text: '@kilocode-dev please fix' }),
      platformIntegration: createIntegration({
        owned_by_organization_id: null,
        owned_by_user_id: 'user_1',
      }),
    });

    expect(result).toEqual({ allowed: true });
    expect(mockGetCollaboratorPermissionLevelFn).not.toHaveBeenCalled();
  });
});
