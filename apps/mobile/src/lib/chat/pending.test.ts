import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addKept, rememberAsked, rememberFirstQuestion, titledByAsked } from './pending';
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

  it('names the chat for the first question a later send kept, not the one that replaced it', async () => {
    await rememberFirstQuestion('kept', 'the question it was opened for');
    await addKept('kept', {
      id: 1,
      text: 'the question it was opened for',
      images: [],
      model: 'kilo/one',
      effort: null,
      afterTurns: 0,
      outcome: 'failed',
    });
    await rememberAsked('kept', {
      text: 'the question asked after it',
      model: 'kilo/one',
      effort: null,
      images: [],
    });

    expect(await titledByAsked([row('kept', '')])).toEqual([
      row('kept', 'the question it was opened for'),
    ]);
  });

  it('keeps naming the chat for the first question after that one is asked again', async () => {
    await rememberFirstQuestion('retried', 'the question it was opened for');
    // The first question was asked again, so the only kept question is the later one.
    await addKept('retried', {
      id: 1,
      text: 'the question asked after it',
      images: [],
      model: 'kilo/one',
      effort: null,
      afterTurns: 0,
      outcome: 'failed',
    });
    await rememberAsked('retried', {
      text: 'the question it was opened for',
      model: 'kilo/one',
      effort: null,
      images: [],
    });

    expect(await titledByAsked([row('retried', '')])).toEqual([
      row('retried', 'the question it was opened for'),
    ]);
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
