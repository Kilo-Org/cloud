import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  askedIn,
  forgetAsked,
  keptIn,
  newKeptId,
  recordAskedFailure,
  rememberAsked,
  rememberFirstQuestion,
  replaceKept,
  titledByAsked,
} from './pending';
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

  it('names the chat for the first question a later send kept, not the one that replaced it', async () => {
    await rememberFirstQuestion('kept', 'the question it was opened for');
    await replaceKept('kept', [
      {
        id: 'k1',
        text: 'the question it was opened for',
        images: [],
        model: 'kilo/one',
        effort: null,
        afterTurns: 0,
        outcome: 'failed',
      },
    ]);
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
    await replaceKept('retried', [
      {
        id: 'k1',
        text: 'the question asked after it',
        images: [],
        model: 'kilo/one',
        effort: null,
        afterTurns: 0,
        outcome: 'failed',
      },
    ]);
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

  it('names each question with an identifier no other question has', () => {
    // An identifier is made, not read from the list, which may not hold a queued
    // retry's copy yet: taking the next free number would land on that copy.
    expect(newKeptId()).not.toBe(newKeptId());
  });

  it('writes the whole list, so two questions that say the same words stay two attempts', async () => {
    const words = {
      text: 'the same words',
      images: [],
      model: 'kilo/one',
      effort: null,
      afterTurns: 0,
      outcome: 'failed' as const,
    };
    await replaceKept('twice', [
      { id: 'a', ...words },
      { id: 'b', ...words },
    ]);

    const written = await keptIn('twice');
    expect(written.map(one => one.id)).toEqual(['a', 'b']);
    // A later write replaces the list rather than adding to it.
    await replaceKept('twice', [{ id: 'b', ...words }]);
    const replaced = await keptIn('twice');
    expect(replaced.map(one => one.id)).toEqual(['b']);
  });

  it('reads an entry written with a numbered identifier as the name it is', async () => {
    stored.set(
      'chat-kept-questions:numbered',
      JSON.stringify([
        {
          id: 4,
          text: 'a numbered entry',
          model: 'kilo/one',
          effort: null,
          images: [],
          afterTurns: 0,
          outcome: 'failed',
        },
      ])
    );

    const written = await keptIn('numbered');
    expect(written.map(one => one.id)).toEqual(['4']);
  });

  it('answers the readable entries when one of them cannot be read', async () => {
    const entry = (id: string, text: string) => ({
      id,
      text,
      model: 'kilo/one',
      effort: null,
      images: [],
      afterTurns: 0,
      outcome: 'failed',
    });
    stored.set(
      'chat-kept-questions:partial',
      JSON.stringify([entry('a', 'the readable one'), { nope: true }, entry('b', 'the other one')])
    );
    stored.set('chat-kept-questions:garbled', 'not json');
    stored.set('chat-kept-questions:shapeless', JSON.stringify({ nope: true }));

    const written = await keptIn('partial');
    expect(written.map(one => one.text)).toEqual(['the readable one', 'the other one']);
    // A record nothing can read is answered empty rather than thrown out of the open.
    expect(await keptIn('garbled')).toEqual([]);
    expect(await keptIn('shapeless')).toEqual([]);
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
