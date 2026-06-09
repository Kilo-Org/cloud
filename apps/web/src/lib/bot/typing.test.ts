const mockAddReactionToIssueCommentFn = jest.fn();
const mockAddReactionToPRFn = jest.fn();
const mockAddReactionToPRReviewCommentFn = jest.fn();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  addReactionToIssueComment: (...args: unknown[]) => mockAddReactionToIssueCommentFn(...args),
  addReactionToPR: (...args: unknown[]) => mockAddReactionToPRFn(...args),
  addReactionToPRReviewComment: (...args: unknown[]) => mockAddReactionToPRReviewCommentFn(...args),
}));

import type { PlatformIntegration } from '@kilocode/db';
import type { Message, Thread } from 'chat';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { startTyping } from './typing';

function createIntegration(overrides: Partial<PlatformIntegration> = {}): PlatformIntegration {
  return {
    platform_installation_id: '98765',
    github_app_type: 'standard',
    ...overrides,
  } as PlatformIntegration;
}

function createThread(params: { adapterName: string; id: string }): Thread {
  return {
    adapter: { name: params.adapterName },
    id: params.id,
    startTyping: jest.fn(async () => undefined),
  } as unknown as Thread;
}

function createMessage(params: { id: string; raw?: unknown } = { id: '123' }): Message {
  return {
    id: params.id,
    raw: params.raw ?? {},
  } as Message;
}

describe('startTyping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses the chat-sdk typing indicator outside GitHub', async () => {
    const thread = createThread({ adapterName: PLATFORM.SLACK, id: 'thread-1' });

    const indicator = await startTyping({
      thread,
      message: createMessage(),
      platformIntegration: createIntegration(),
    });
    await indicator.done();

    expect(thread.startTyping).toHaveBeenCalledWith('Thinking...');
    expect(mockAddReactionToIssueCommentFn).not.toHaveBeenCalled();
    expect(mockAddReactionToPRFn).not.toHaveBeenCalled();
    expect(mockAddReactionToPRReviewCommentFn).not.toHaveBeenCalled();
  });

  it('adds eyes and completion reactions to GitHub issue comments', async () => {
    const thread = createThread({
      adapterName: PLATFORM.GITHUB,
      id: 'github:Kilo-Org/on-call:issue:37',
    });
    const message = createMessage({ id: '101', raw: { comment: { id: 101 } } });

    const indicator = await startTyping({
      thread,
      message,
      platformIntegration: createIntegration(),
    });
    await indicator.done();

    expect(thread.startTyping).not.toHaveBeenCalled();
    expect(mockAddReactionToIssueCommentFn).toHaveBeenNthCalledWith(
      1,
      '98765',
      'Kilo-Org',
      'on-call',
      101,
      'eyes',
      'standard'
    );
    expect(mockAddReactionToIssueCommentFn).toHaveBeenNthCalledWith(
      2,
      '98765',
      'Kilo-Org',
      'on-call',
      101,
      '+1',
      'standard'
    );
  });

  it('adds eyes and completion reactions to GitHub review comments', async () => {
    const thread = createThread({
      adapterName: PLATFORM.GITHUB,
      id: 'github:Kilo-Org/on-call:37:rc:202',
    });

    const indicator = await startTyping({
      thread,
      message: createMessage({ id: '203' }),
      platformIntegration: createIntegration({ github_app_type: 'lite' }),
    });
    await indicator.done();

    expect(mockAddReactionToPRReviewCommentFn).toHaveBeenNthCalledWith(
      1,
      '98765',
      'Kilo-Org',
      'on-call',
      203,
      'eyes',
      'lite'
    );
    expect(mockAddReactionToPRReviewCommentFn).toHaveBeenNthCalledWith(
      2,
      '98765',
      'Kilo-Org',
      'on-call',
      203,
      '+1',
      'lite'
    );
  });

  it('does not let GitHub reaction failures block message processing', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAddReactionToIssueCommentFn.mockRejectedValueOnce(new Error('rate limited'));
    const thread = createThread({
      adapterName: PLATFORM.GITHUB,
      id: 'github:Kilo-Org/on-call:issue:37',
    });

    const indicator = await startTyping({
      thread,
      message: createMessage({ id: '101' }),
      platformIntegration: createIntegration(),
    });
    await indicator.done();

    expect(mockAddReactionToIssueCommentFn).toHaveBeenCalledTimes(2);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[Bot] Failed to add GitHub bot reaction:',
      expect.any(Error)
    );
    consoleWarnSpy.mockRestore();
  });
});
