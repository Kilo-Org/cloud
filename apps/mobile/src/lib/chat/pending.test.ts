import { beforeEach, describe, expect, it, vi } from 'vitest';

import { askedIn, forgetAsked, recordAskedFailure, rememberAsked, titledByAsked } from './pending';
import { DERIVED_CHAT_TEXT_MAX_LENGTH } from './title';

const stored = vi.hoisted(() => new Map<string, string>());
vi.mock('@/lib/persist/encrypted-kv', () => ({
  getItem: async (scope: string, key: string) => {
    await Promise.resolve();
    return stored.get(`${scope}:${key}`) ?? null;
  },
  setItem: async (scope: string, key: string, value: string) => {
    await Promise.resolve();
    stored.set(`${scope}:${key}`, value);
  },
  removeItem: async (scope: string, key: string) => {
    await Promise.resolve();
    stored.delete(`${scope}:${key}`);
  },
}));

const row = (sessionId: string, title: string) => ({
  sessionId,
  model: 'kilo/one',
  title,
  preview: '',
  updatedAt: 1,
});

beforeEach(() => {
  stored.clear();
});

describe('the reason a question failed', () => {
  const question = { text: 'what is a monad', model: 'kilo/one', effort: null, images: [] };

  it('is kept with the question that waits', async () => {
    await rememberAsked('failed', question);
    await recordAskedFailure('failed', 'modelChat.creditsRequired');

    expect(await askedIn('failed')).toMatchObject({
      text: 'what is a monad',
      failureKey: 'modelChat.creditsRequired',
    });
  });

  it('is cleared when the question is asked again', async () => {
    await rememberAsked('asked-again', question);
    await recordAskedFailure('asked-again', 'modelChat.creditsRequired');

    await rememberAsked('asked-again', question);

    expect(await askedIn('asked-again')).toMatchObject({ failureKey: null });
  });

  it('is dropped with the question', async () => {
    await rememberAsked('answered', question);
    await recordAskedFailure('answered', 'modelChat.creditsRequired');

    await forgetAsked('answered');

    expect(await askedIn('answered')).toBeNull();
  });

  it('has nowhere to stay without a remembered question', async () => {
    await recordAskedFailure('unknown', 'modelChat.creditsRequired');

    expect(await askedIn('unknown')).toBeNull();
  });

  it('reads a question remembered before failures were kept as one with none', async () => {
    stored.set(
      'chat-asked-target:older',
      JSON.stringify({ text: 'older question', model: 'kilo/one', effort: null, images: [] })
    );

    expect(await askedIn('older')).toMatchObject({ text: 'older question', failureKey: null });
  });
});

describe('titledByAsked', () => {
  it('names a chat whose only question failed with that question', async () => {
    await rememberAsked('failed', {
      text: 'what is a monad',
      model: 'kilo/one',
      effort: null,
      images: [],
    });

    expect(await titledByAsked([row('failed', '')])).toEqual([row('failed', 'what is a monad')]);
  });

  it('keeps the name or the first stored question over the one that waits', async () => {
    await rememberAsked('renamed', {
      text: 'later question',
      model: 'kilo/one',
      effort: null,
      images: [],
    });
    await rememberAsked('answered', {
      text: 'later question',
      model: 'kilo/one',
      effort: null,
      images: [],
    });

    expect(
      await titledByAsked([row('renamed', 'Greetings'), row('answered', 'first question')])
    ).toEqual([row('renamed', 'Greetings'), row('answered', 'first question')]);
  });

  it('leaves a chat with no question untitled', async () => {
    expect(await titledByAsked([row('fresh', '')])).toEqual([row('fresh', '')]);
  });

  it('reduces the waiting question to one short line instead of the whole message', async () => {
    const long = 'a question about the composer '.repeat(200);
    await rememberAsked('long', {
      text: long,
      model: 'kilo/one',
      effort: null,
      images: [],
    });

    const [titled] = await titledByAsked([row('long', '')]);

    expect(titled?.title).toHaveLength(DERIVED_CHAT_TEXT_MAX_LENGTH);
    expect(titled?.title.endsWith('…')).toBe(true);
  });
});
