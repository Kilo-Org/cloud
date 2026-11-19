import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isChatFixtureState, writeChatFixture } from './chat-fixture';
import { type ChatPlace } from './scope';
import { type Displaced } from './state';

const mocks = vi.hoisted(() => ({
  database: { runSync: vi.fn() },
  rememberChat: vi.fn(),
  forgetQuestions: vi.fn(() => Promise.resolve()),
  rememberAsked: vi.fn(() => Promise.resolve()),
  replaceKept: vi.fn((_sessionId: string, _kept: readonly Displaced[]) => Promise.resolve()),
}));

vi.mock('@/lib/persist/encrypted-kv', () => ({
  encryptedDatabase: () => Promise.resolve(mocks.database),
}));
vi.mock('./store', () => ({ rememberChat: mocks.rememberChat }));
vi.mock('./backend-target', () => ({ CREDITS_FAILURE_KEY: 'modelChat.creditsRequired' }));
vi.mock('./pending', () => ({
  forgetQuestions: mocks.forgetQuestions,
  rememberAsked: mocks.rememberAsked,
  replaceKept: mocks.replaceKept,
}));

const place: ChatPlace = { chatScope: 'user-1:personal', org: { kind: 'personal' } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('writeChatFixture', () => {
  it('records only the chat row for the empty state', async () => {
    expect(await writeChatFixture(place, 'empty')).toBe('chat-fixture-empty');
    expect(mocks.forgetQuestions).toHaveBeenCalledWith('chat-fixture-empty');
    expect(mocks.rememberChat).toHaveBeenCalledWith(mocks.database, {
      sessionId: 'chat-fixture-empty',
      scope: 'user-1:personal',
      at: expect.any(Number),
    });
    expect(mocks.rememberAsked).not.toHaveBeenCalled();
    expect(mocks.replaceKept).not.toHaveBeenCalled();
  });

  it('remembers a question with a transient failure', async () => {
    await writeChatFixture(place, 'failed');
    expect(mocks.rememberAsked).toHaveBeenCalledWith(
      'chat-fixture-failed',
      expect.objectContaining({ failureKey: 'common.somethingWentWrong', images: [] })
    );
  });

  it('remembers a question the balance refused', async () => {
    await writeChatFixture(place, 'credits');
    expect(mocks.rememberAsked).toHaveBeenCalledWith(
      'chat-fixture-credits',
      expect.objectContaining({ failureKey: 'modelChat.creditsRequired' })
    );
  });

  it('keeps twelve long questions before the failed one', async () => {
    await writeChatFixture(place, 'long');
    const kept = mocks.replaceKept.mock.calls[0]?.[1] ?? [];
    expect(kept).toHaveLength(12);
    expect(new Set(kept.map(question => question.id)).size).toBe(12);
    expect(mocks.rememberAsked).toHaveBeenCalledWith(
      'chat-fixture-long',
      expect.objectContaining({ text: expect.stringContaining('```ts') })
    );
  });
});

describe('isChatFixtureState', () => {
  it('accepts only the listed states', () => {
    expect(isChatFixtureState('long')).toBe(true);
    expect(isChatFixtureState('happy')).toBe(false);
  });
});
