const mockCreateLinearLinkTokenFn = jest.fn<string, [unknown]>(() => 'stub-link-token');

function mockCreateLinearLinkToken(arg: unknown) {
  return mockCreateLinearLinkTokenFn(arg);
}

jest.mock('@/lib/bot/linear-link-token', () => ({
  createLinearLinkToken: mockCreateLinearLinkToken,
}));

const mockLinearIssueFn = jest.fn();

function mockLinearClientFactory(...args: unknown[]) {
  return mockLinearClientConstructor(...args);
}

const mockLinearClientConstructor = jest.fn((..._args: unknown[]) => ({
  issue: (id: string) => mockLinearIssueFn(id),
}));

jest.mock('@linear/sdk', () => ({
  LinearClient: jest
    .fn()
    .mockImplementation((...args: unknown[]) => mockLinearClientFactory(...args)),
}));

import type {
  LinearAdapter,
  LinearCommentRawMessage,
  LinearAgentSessionCommentRawMessage,
  LinearInstallation,
} from '@chat-adapter/linear';
import type { PlatformIntegration } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { createLinearBotPlatform } from './linear';

const linearPlatform = createLinearBotPlatform({
  name: 'linear',
  withInstallation: async <T>(_orgId: unknown, fn: () => Promise<T> | T) => fn(),
} as unknown as LinearAdapter);

function createCommentRaw(
  overrides: Partial<LinearCommentRawMessage> = {}
): LinearCommentRawMessage {
  return {
    kind: 'comment',
    organizationId: 'org-abc',
    comment: {
      id: 'cmt-1',
      body: 'Hello Kilo',
      createdAt: '2026-05-05T07:00:00.000Z',
      updatedAt: '2026-05-05T07:00:00.000Z',
      issueId: 'iss-1',
      parentId: undefined,
      url: 'https://linear.app/kilo/issue/KILO-1#comment-cmt-1',
      user: {
        id: 'usr-1',
        type: 'user',
        displayName: 'Remon',
        fullName: 'Remon Doe',
        email: undefined,
        avatarUrl: undefined,
      },
    },
    ...overrides,
  };
}

function createMessage(raw: unknown, overrides: Partial<Message> = {}): Message {
  const id = overrides.id ?? 'cmt-1';
  const text = overrides.text ?? 'Hello Kilo';
  const authorName = overrides.author?.fullName ?? 'Remon Doe';
  return {
    id,
    threadId: 'linear:iss-1',
    text,
    formatted: { type: 'root', children: [] },
    raw,
    author: {
      fullName: authorName,
      isBot: false,
      isMe: false,
      userId: 'usr-1',
      userName: 'Remon',
      ...overrides.author,
    },
    metadata: {
      dateSent: new Date('2026-05-05T07:00:00Z'),
      edited: false,
      ...overrides.metadata,
    },
    attachments: [],
    links: [],
    toJSON: () => ({
      _type: 'chat:Message',
      id,
      threadId: 'linear:iss-1',
      text,
      attachments: [],
      author: {
        fullName: authorName,
        isBot: false,
        isMe: false,
        userId: 'usr-1',
        userName: 'Remon',
      },
      formatted: { type: 'root', children: [] },
      metadata: { dateSent: '2026-05-05T07:00:00.000Z', edited: false },
      raw,
    }),
  } as unknown as Message;
}

type PostSpy = jest.Mock<Promise<void>, [{ markdown: string }]>;

async function* asAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

function createThread(
  post: PostSpy = jest.fn<Promise<void>, [{ markdown: string }]>(async () => undefined),
  overrides: { threadMessages?: Message[]; id?: string } = {}
): Thread {
  const id = overrides.id ?? 'linear:iss-1';
  return {
    id,
    adapter: { name: 'linear' },
    isDM: false,
    channel: {
      fetchMetadata: async () => null,
    },
    get messages() {
      return asAsyncIterable(overrides.threadMessages ?? []);
    },
    post,
    toJSON: () => ({
      _type: 'chat:Thread',
      adapterName: 'linear',
      channelId: id,
      id,
      isDM: false,
    }),
  } as unknown as Thread;
}

function createPlatformIntegration(
  overrides: Partial<PlatformIntegration> = {}
): PlatformIntegration {
  return {
    id: 'pi_1',
    platform: PLATFORM.LINEAR,
    platform_installation_id: 'org-abc',
    metadata: null,
    ...overrides,
  } as PlatformIntegration;
}

describe('createLinearBotPlatform.getIdentity', () => {
  it('extracts organizationId from a LinearCommentRawMessage', async () => {
    const identity = await linearPlatform.getIdentity({
      thread: createThread(),
      message: createMessage(createCommentRaw()),
    });

    expect(identity).toEqual({
      platform: PLATFORM.LINEAR,
      teamId: 'org-abc',
      userId: 'usr-1',
    });
  });

  it('extracts organizationId from a LinearAgentSessionCommentRawMessage', async () => {
    const agentRaw: LinearAgentSessionCommentRawMessage = {
      kind: 'agent_session_comment',
      organizationId: 'org-xyz',
      agentSessionId: 'sess-1',
      comment: createCommentRaw().comment,
    };

    const identity = await linearPlatform.getIdentity({
      thread: createThread(),
      message: createMessage(agentRaw),
    });

    expect(identity.teamId).toBe('org-xyz');
  });

  it('throws when raw payload is missing organizationId', async () => {
    await expect(
      linearPlatform.getIdentity({
        thread: createThread(),
        message: createMessage({ kind: 'comment' }),
      })
    ).rejects.toThrow(/organizationId/);
  });
});

describe('createLinearBotPlatform.isEnabledForBot', () => {
  function integrationWithMetadata(metadata: PlatformIntegration['metadata']): PlatformIntegration {
    return { metadata } as PlatformIntegration;
  }

  it('returns true only when metadata.bot_enabled is the boolean true', () => {
    expect(linearPlatform.isEnabledForBot(integrationWithMetadata({ bot_enabled: true }))).toBe(
      true
    );
  });

  it('returns false when metadata is missing the flag', () => {
    expect(linearPlatform.isEnabledForBot(integrationWithMetadata({}))).toBe(false);
    expect(linearPlatform.isEnabledForBot(integrationWithMetadata(null))).toBe(false);
  });

  it('rejects non-boolean truthy values to avoid accidental enables', () => {
    expect(linearPlatform.isEnabledForBot(integrationWithMetadata({ bot_enabled: 'true' }))).toBe(
      false
    );
    expect(linearPlatform.isEnabledForBot(integrationWithMetadata({ bot_enabled: 1 }))).toBe(false);
  });
});

describe('createLinearBotPlatform.getRequesterInfo', () => {
  it('surfaces the Linear comment URL as the messageLink', async () => {
    const info = await linearPlatform.getRequesterInfo({
      message: createMessage(createCommentRaw()),
      platformIntegration: {} as PlatformIntegration,
      displayName: 'Remon Doe',
    });

    expect(info).toEqual({
      displayName: 'Remon Doe',
      platform: PLATFORM.LINEAR,
      messageLink: 'https://linear.app/kilo/issue/KILO-1#comment-cmt-1',
    });
  });

  it('omits messageLink when the raw payload does not expose a URL', async () => {
    const rawWithoutUrl = createCommentRaw({
      comment: { ...createCommentRaw().comment, url: undefined },
    });

    const info = await linearPlatform.getRequesterInfo({
      message: createMessage(rawWithoutUrl),
      platformIntegration: {} as PlatformIntegration,
      displayName: 'Remon Doe',
    });

    expect(info).toEqual({
      displayName: 'Remon Doe',
      platform: PLATFORM.LINEAR,
    });
  });
});

describe('createLinearBotPlatform.promptLinkAccount', () => {
  beforeEach(() => {
    mockCreateLinearLinkTokenFn.mockClear();
  });

  it('does not opt into the generic /api/chat/link-account route', () => {
    expect(linearPlatform.usesGenericLinkAccountRoute).toBe(false);
  });

  it('posts a markdown link pointing at /linear/link with a token derived from the integration, not the comment author', async () => {
    const post: PostSpy = jest.fn<Promise<void>, [{ markdown: string }]>(async () => undefined);
    const thread = createThread(post);
    const message = createMessage(createCommentRaw());

    await linearPlatform.promptLinkAccount({
      thread,
      message,
      identity: { platform: PLATFORM.LINEAR, teamId: 'org-abc', userId: 'usr-1' },
      platformIntegration: createPlatformIntegration({ id: 'pi_1' }),
      state: {} as never,
    });

    expect(mockCreateLinearLinkTokenFn).toHaveBeenCalledTimes(1);
    expect(mockCreateLinearLinkTokenFn).toHaveBeenCalledWith({
      platformIntegrationId: 'pi_1',
      organizationId: 'org-abc',
    });

    expect(post).toHaveBeenCalledTimes(1);
    const firstCall = post.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [arg] = firstCall;
    expect(arg.markdown).toContain('[Link your Kilo account]');
    expect(arg.markdown).toContain('/linear/link?token=stub-link-token');
    // The Linear user id from the comment author must not leak into the URL.
    expect(arg.markdown).not.toContain('usr-1');
  });
});

describe('createLinearBotPlatform.withAuthContext', () => {
  it('runs the fn via the adapter withInstallation using platform_installation_id', async () => {
    const withInstallation = jest.fn(async <T>(_id: unknown, fn: () => Promise<T> | T) => fn());
    const platform = createLinearBotPlatform({
      name: 'linear',
      withInstallation,
    } as unknown as LinearAdapter);

    const result = await platform.withAuthContext({
      platformIntegration: {
        id: 'pi_1',
        platform_installation_id: 'org-abc',
      } as PlatformIntegration,
      fn: async () => 'ok',
    });

    expect(result).toBe('ok');
    expect(withInstallation).toHaveBeenCalledWith('org-abc', expect.any(Function));
  });

  it('throws when the integration is missing platform_installation_id', async () => {
    const platform = createLinearBotPlatform({
      name: 'linear',
      withInstallation: async <T>(_id: unknown, fn: () => Promise<T> | T) => fn(),
    } as unknown as LinearAdapter);

    await expect(
      platform.withAuthContext({
        platformIntegration: {
          id: 'pi_1',
          platform_installation_id: null,
        } as PlatformIntegration,
        fn: async () => 'ok',
      })
    ).rejects.toThrow(/organization id/i);
  });
});

describe('createLinearBotPlatform.getConversationContext', () => {
  const defaultInstallation: LinearInstallation = {
    accessToken: 'lin_api_test',
    botUserId: 'bot-1',
    expiresAt: null,
    organizationId: 'org-abc',
  };

  type AdapterHarness = {
    adapter: LinearAdapter;
    getInstallation: jest.Mock;
    decodeThreadId: jest.Mock;
    withInstallation: jest.Mock;
  };

  function buildAdapter(
    overrides: {
      installation?: LinearInstallation | null;
      decodeThreadId?: (id: string) => { issueId: string };
    } = {}
  ): AdapterHarness {
    const installation =
      overrides.installation === undefined ? defaultInstallation : overrides.installation;
    const getInstallation = jest.fn(async () => installation);
    const decodeThreadId = jest.fn(
      overrides.decodeThreadId ?? ((id: string) => ({ issueId: id.replace(/^linear:/, '') }))
    );
    const withInstallation = jest.fn(async <T>(_id: unknown, fn: () => Promise<T> | T) => fn());

    return {
      getInstallation,
      decodeThreadId,
      withInstallation,
      adapter: {
        name: 'linear',
        getInstallation,
        decodeThreadId,
        withInstallation,
      } as unknown as LinearAdapter,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  type FakeLinearComment = {
    id: string;
    body: string;
    createdAt: Date;
    user: Promise<{ displayName?: string; name?: string } | null>;
  };

  function mockIssueWithComments(
    issue: {
      identifier: string;
      title: string;
      url: string;
      description: string | null;
      state?: Promise<{ name: string }> | undefined;
    },
    comments: FakeLinearComment[] = []
  ): void {
    mockLinearIssueFn.mockResolvedValue({
      ...issue,
      comments: async () => ({ nodes: comments }),
    });
  }

  function makeComment(overrides: Partial<FakeLinearComment> & { id: string }): FakeLinearComment {
    return {
      body: 'comment body',
      createdAt: new Date('2026-05-05T07:00:00Z'),
      user: Promise.resolve({ displayName: 'Remon', name: 'Remon Doe' }),
      ...overrides,
    };
  }

  it('includes issue metadata, description, and issue comment history', async () => {
    const harness = buildAdapter();
    const platform = createLinearBotPlatform(harness.adapter);

    mockIssueWithComments(
      {
        identifier: 'KILO-1',
        title: 'Fix the bot',
        url: 'https://linear.app/kilo/issue/KILO-1',
        description: 'The bot stopped answering mentions after the last deploy.',
        state: Promise.resolve({ name: 'In Progress' }),
      },
      [
        makeComment({
          id: 'cmt-earlier',
          body: 'Any update on this one?',
          createdAt: new Date('2026-05-05T06:00:00Z'),
        }),
        makeComment({
          id: 'cmt-older',
          body: 'I reproduced it too.',
          createdAt: new Date('2026-05-04T09:30:00Z'),
          user: Promise.resolve({ displayName: 'Other', name: 'Other Person' }),
        }),
      ]
    );

    const triggerMessage = createMessage(createCommentRaw(), {
      id: 'cmt-1',
      text: '@kilo please take a look',
    });

    const context = await platform.getConversationContext({
      thread: createThread(undefined, { threadMessages: [triggerMessage] }),
      triggerMessage,
      platformIntegration: createPlatformIntegration(),
    });

    expect(harness.withInstallation).toHaveBeenCalledWith('org-abc', expect.any(Function));
    expect(mockLinearIssueFn).toHaveBeenCalledWith('iss-1');

    expect(context).toContain('Linear conversation context:');
    expect(context).toContain('- Issue: KILO-1 Fix the bot');
    expect(context).toContain('- State: In Progress');
    expect(context).toContain('- URL: https://linear.app/kilo/issue/KILO-1');
    expect(context).toContain('Issue description:');
    expect(context).toContain(
      '<linear_issue_description>The bot stopped answering mentions after the last deploy.</linear_issue_description>'
    );
    expect(context).toContain('Issue comments (oldest first):');
    expect(context).toContain('Any update on this one?');
    expect(context).toContain('I reproduced it too.');

    // Comments are sorted oldest-first.
    const olderIdx = context.indexOf('I reproduced it too.');
    const newerIdx = context.indexOf('Any update on this one?');
    expect(olderIdx).toBeGreaterThan(-1);
    expect(newerIdx).toBeGreaterThan(olderIdx);
  });

  it('excludes the trigger comment from the rendered history', async () => {
    const harness = buildAdapter();
    const platform = createLinearBotPlatform(harness.adapter);

    mockIssueWithComments(
      {
        identifier: 'KILO-2',
        title: 'Another one',
        url: 'https://linear.app/kilo/issue/KILO-2',
        description: null,
        state: undefined,
      },
      [
        makeComment({ id: 'cmt-prior', body: 'earlier comment' }),
        makeComment({ id: 'cmt-trigger', body: '@kilo please take a look' }),
      ]
    );

    const triggerMessage = createMessage(createCommentRaw(), {
      id: 'cmt-trigger',
      text: '@kilo please take a look',
    });

    const context = await platform.getConversationContext({
      thread: createThread(),
      triggerMessage,
      platformIntegration: createPlatformIntegration(),
    });

    expect(context).toContain('earlier comment');
    expect(context).not.toContain('@kilo please take a look');
  });

  it('returns an empty string when there is no linear installation', async () => {
    const harness = buildAdapter({ installation: null });
    const platform = createLinearBotPlatform(harness.adapter);

    const context = await platform.getConversationContext({
      thread: createThread(),
      triggerMessage: createMessage(createCommentRaw()),
      platformIntegration: createPlatformIntegration(),
    });

    expect(context).toBe('');
    expect(mockLinearIssueFn).not.toHaveBeenCalled();
  });

  it('returns an empty string and logs when issue fetching fails', async () => {
    const harness = buildAdapter();
    const platform = createLinearBotPlatform(harness.adapter);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    mockLinearIssueFn.mockRejectedValue(new Error('boom'));

    const context = await platform.getConversationContext({
      thread: createThread(),
      triggerMessage: createMessage(createCommentRaw()),
      platformIntegration: createPlatformIntegration(),
    });

    expect(context).toBe('');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws when the integration is missing an organization id', async () => {
    const harness = buildAdapter();
    const platform = createLinearBotPlatform(harness.adapter);

    await expect(
      platform.getConversationContext({
        thread: createThread(),
        triggerMessage: createMessage(createCommentRaw()),
        platformIntegration: createPlatformIntegration({ platform_installation_id: null }),
      })
    ).rejects.toThrow(/organization id/i);

    expect(harness.withInstallation).not.toHaveBeenCalled();
    expect(mockLinearIssueFn).not.toHaveBeenCalled();
  });

  it('omits description, state, and comments when Linear returns nothing for them', async () => {
    const harness = buildAdapter();
    const platform = createLinearBotPlatform(harness.adapter);

    mockIssueWithComments({
      identifier: 'KILO-9',
      title: 'Empty issue',
      url: 'https://linear.app/kilo/issue/KILO-9',
      description: null,
      state: undefined,
    });

    const context = await platform.getConversationContext({
      thread: createThread(),
      triggerMessage: createMessage(createCommentRaw()),
      platformIntegration: createPlatformIntegration(),
    });

    expect(context).toContain('- Issue: KILO-9 Empty issue');
    expect(context).toContain('- URL: https://linear.app/kilo/issue/KILO-9');
    expect(context).not.toContain('- State:');
    expect(context).not.toContain('Issue description:');
    expect(context).not.toContain('<linear_issue_description>');
    expect(context).not.toContain('Issue comments (oldest first):');
    expect(context).not.toContain('<linear_comment');
  });

  it('falls back to "unknown" when a comment has no author info', async () => {
    const harness = buildAdapter();
    const platform = createLinearBotPlatform(harness.adapter);

    mockIssueWithComments(
      {
        identifier: 'KILO-3',
        title: 'Anon issue',
        url: 'https://linear.app/kilo/issue/KILO-3',
        description: null,
        state: undefined,
      },
      [
        makeComment({
          id: 'cmt-anon',
          body: 'from nobody',
          user: Promise.resolve(null),
        }),
      ]
    );

    const context = await platform.getConversationContext({
      thread: createThread(),
      triggerMessage: createMessage(createCommentRaw()),
      platformIntegration: createPlatformIntegration(),
    });

    expect(context).toContain('author="unknown"');
    expect(context).toContain('from nobody');
  });
});
