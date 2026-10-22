import { beforeEach, describe, expect, it, vi } from 'vitest';

import { rememberAsked, titledByAsked } from './pending';

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

  it('leaves a chat with no question untitled', async () => {
    expect(await titledByAsked([row('fresh', '')])).toEqual([row('fresh', '')]);
  });
});
