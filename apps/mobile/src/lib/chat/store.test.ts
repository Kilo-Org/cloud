import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { SessionStore, type Turn } from '@kilocode/harness-sdk';
import { layerNodeStore } from '@kilocode/harness-sdk/plugins/store/node';
import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  type ChatDatabase,
  deleteChat,
  listChats,
  moveChat,
  rememberChat,
  scopeOfChat,
  wipeChats,
} from './store';

/**
 * The list and the delete run against the real schema of both owners: the SDK's
 * store plugin creates its own tables, and the app's `chats` table comes from
 * the migration the app ships. Neither is restated here, so a schema that moves
 * breaks this suite rather than passing against a copy that no longer matches.
 */

const CHATS = readFileSync(
  new URL('../../../drizzle/0001_safe_hellfire_club.sql', import.meta.url),
  'utf8'
);

const chatDatabase = (database: DatabaseSync): ChatDatabase => ({
  getAllSync: <T>(source: string, params: (string | number)[]) =>
    database.prepare(source).all(...params) as T[],
  runSync: (source: string, params: (string | number)[]) => {
    database.prepare(source).run(...params);
  },
});

const said = (sessionId: string, role: Turn['role'], body: string): Turn => ({
  id: `${sessionId}-${role}`,
  sessionId,
  role,
  parts: [{ id: `${sessionId}-${role}-1`, kind: 'text', body }],
});

let database = new DatabaseSync(':memory:');
let db: ChatDatabase = chatDatabase(database);

/** Writes a session and one exchange through the SDK, as the app does. */
const conversation = (sessionId: string, model: string, question: string) =>
  Effect.gen(function* conversing() {
    const store = yield* SessionStore;
    yield* store.create({ id: sessionId, system: 'be brief', model });
    yield* store.append({
      sessionId,
      turns: [said(sessionId, 'user', question), said(sessionId, 'assistant', 'ok')],
      prompted: 10,
    });
    yield* store.flush();
  });

const write = async (work: Effect.Effect<void, unknown, SessionStore>) => {
  await Effect.runPromise(Effect.provide(work, layerNodeStore(database)) as Effect.Effect<void>);
};

beforeEach(async () => {
  database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  for (const statement of CHATS.split('--> statement-breakpoint')) {
    database.exec(statement);
  }
  db = chatDatabase(database);
  // Opening the store is what creates its tables, and the list reads them even
  // when this test writes no conversation of its own.
  await write(Effect.void);
});

describe('listChats', () => {
  it('lists one scope newest first, titled by the first thing the user said', async () => {
    await write(conversation('s1', 'kilo/one', 'what is a monad'));
    await write(conversation('s2', 'kilo/two', 'and a functor'));
    await write(conversation('s3', 'kilo/one', 'not yours'));
    rememberChat(db, { sessionId: 's1', scope: 'me:personal', at: 100 });
    rememberChat(db, { sessionId: 's2', scope: 'me:personal', at: 200 });
    rememberChat(db, { sessionId: 's3', scope: 'me:acme', at: 300 });

    expect(listChats(db, 'me:personal')).toEqual([
      { sessionId: 's2', model: 'kilo/two', title: 'and a functor', updatedAt: 200 },
      { sessionId: 's1', model: 'kilo/one', title: 'what is a monad', updatedAt: 100 },
    ]);
  });

  it('leaves out a chat whose session was never written', () => {
    rememberChat(db, { sessionId: 'ghost', scope: 'me:personal', at: 100 });

    expect(listChats(db, 'me:personal')).toEqual([]);
  });

  it('gives an empty title to a chat nothing was said in', async () => {
    await write(
      Effect.gen(function* opening() {
        const store = yield* SessionStore;
        yield* store.create({ id: 'fresh', system: 'be brief', model: 'kilo/one' });
        yield* store.flush();
      })
    );
    rememberChat(db, { sessionId: 'fresh', scope: 'me:personal', at: 1 });

    expect(listChats(db, 'me:personal')[0]?.title).toBe('');
  });
});

describe('moveChat', () => {
  it('keeps one row when a chat moves onto another model', async () => {
    await write(conversation('old', 'kilo/one', 'hello'));
    await write(conversation('new', 'kilo/two', 'hello'));
    rememberChat(db, { sessionId: 'old', scope: 'me:personal', at: 100 });

    moveChat(db, { from: 'old', to: 'new', at: 400 });

    expect(listChats(db, 'me:personal')).toEqual([
      { sessionId: 'new', model: 'kilo/two', title: 'hello', updatedAt: 400 },
    ]);
    expect(scopeOfChat(db, 'old')).toBeNull();
    expect(scopeOfChat(db, 'new')).toBe('me:personal');
  });
});

describe('deleteChat', () => {
  it('removes the row and the conversation under it', async () => {
    await write(conversation('s1', 'kilo/one', 'hello'));
    rememberChat(db, { sessionId: 's1', scope: 'me:personal', at: 100 });

    deleteChat(db, 's1');

    expect(listChats(db, 'me:personal')).toEqual([]);
    for (const table of ['sessions', 'turns', 'parts']) {
      expect(database.prepare(`select count(*) as n from ${table}`).get()).toEqual({ n: 0 });
    }
  });
});

describe('wipeChats', () => {
  it('clears one scope and leaves the other alone', async () => {
    await write(conversation('mine', 'kilo/one', 'hello'));
    await write(conversation('theirs', 'kilo/one', 'hello'));
    rememberChat(db, { sessionId: 'mine', scope: 'me:personal', at: 100 });
    rememberChat(db, { sessionId: 'theirs', scope: 'you:personal', at: 100 });

    wipeChats(db, 'me');

    expect(listChats(db, 'me:personal')).toEqual([]);
    expect(listChats(db, 'you:personal')).toHaveLength(1);
    expect(database.prepare('select count(*) as n from sessions').get()).toEqual({ n: 1 });
  });

  it('takes every account when the account is unknown', async () => {
    await write(conversation('mine', 'kilo/one', 'hello'));
    await write(conversation('theirs', 'kilo/one', 'hello'));
    rememberChat(db, { sessionId: 'mine', scope: 'me:acme', at: 100 });
    rememberChat(db, { sessionId: 'theirs', scope: 'you:personal', at: 100 });

    wipeChats(db, null);

    expect(database.prepare('select count(*) as n from chats').get()).toEqual({ n: 0 });
    expect(database.prepare('select count(*) as n from sessions').get()).toEqual({ n: 0 });
  });

  it('keeps another account whose identifier starts the same way', async () => {
    await write(conversation('mine', 'kilo/one', 'hello'));
    await write(conversation('theirs', 'kilo/one', 'hello'));
    rememberChat(db, { sessionId: 'mine', scope: 'me:personal', at: 100 });
    rememberChat(db, { sessionId: 'theirs', scope: 'mendel:personal', at: 100 });

    wipeChats(db, 'me');

    expect(listChats(db, 'mendel:personal')).toHaveLength(1);
  });
});
