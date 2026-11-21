/* eslint-disable max-lines -- this suite pins the list, the move, the record and both deletes against the real migrations of the two schemas the store spans, so it grows a case at a time and a smaller split would separate each case from the fixtures it needs. */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { SessionStore, type Turn } from '@kilocode/harness-sdk';
import { layerNodeStore } from '@kilocode/harness-sdk/plugins/store/node';
import { Effect } from 'effect';
import { monotonicFactory } from 'ulid';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  type ChatDatabase,
  deleteChat,
  listChats,
  moveChat,
  NO_RECORD,
  recordOfChat,
  recordUsage,
  rememberChat,
  renameChat,
  scopeOfChat,
  toolsOfSession,
  wipeChats,
} from './store';
import { DERIVED_CHAT_TEXT_MAX_LENGTH } from './title';

/**
 * The list and the delete run against the real schema of both owners: the SDK's
 * store plugin creates its own tables, and the app's `chats` table comes from
 * the migration the app ships. Neither is restated here, so a schema that moves
 * breaks this suite rather than passing against a copy that no longer matches.
 */

const CHATS = [
  '0001_safe_hellfire_club.sql',
  '0002_majestic_old_lace.sql',
  '0003_quick_chat_titles.sql',
]
  .map(file => readFileSync(new URL(`../../../drizzle/${file}`, import.meta.url), 'utf8'))
  .join('--> statement-breakpoint');

const chatDatabase = (database: DatabaseSync): ChatDatabase => {
  const db: ChatDatabase = {
    getAllSync: <T>(source: string, params: (string | number)[]) =>
      database.prepare(source).all(...params) as T[],
    runSync: (source: string, params: (string | number)[]) => {
      database.prepare(source).run(...params);
    },
    withTransactionSync: (work: () => void) => {
      database.exec('begin');
      try {
        work();
        database.exec('commit');
      } catch (error) {
        database.exec('rollback');
        throw error;
      }
    },
    isInTransactionSync: () => database.isTransaction,
  };
  return db;
};

/**
 * The same database with a `runSync` a test can count and refuse at a chosen
 * statement. The wipe runs its own transaction, so the rollback it takes on a
 * refusal is the wipe's own.
 */
const watchedDatabase = (database: DatabaseSync, refuseAt?: number) => {
  const counts = { statements: [] as string[], transactions: 0, reads: [] as number[] };
  const plain = chatDatabase(database);
  const db: ChatDatabase = {
    ...plain,
    getAllSync: <T>(source: string, params: (string | number)[]) => {
      /* The transaction count at the moment of the read, so a test can tell
         whether the ids were read inside the unit that deletes them. */
      counts.reads.push(counts.transactions);
      return plain.getAllSync<T>(source, params);
    },
    runSync: (source: string, params: (string | number)[]) => {
      counts.statements.push(source);
      if (counts.statements.length === refuseAt) {
        throw new Error('the database refused the statement');
      }
      plain.runSync(source, params);
    },
    withTransactionSync: (work: () => void) => {
      counts.transactions += 1;
      plain.withTransactionSync(work);
    },
  };
  return { db, counts };
};

/** How many rows one of the store's count queries answers, read back as a number. */
const tally = (source: string): number => db.getAllSync<{ n: number }>(source, [])[0]?.n ?? 0;

/**
 * Part ids order by insertion in the store's own schema — an id is a ULID — and
 * both the title and the preview subqueries read them in that order. The fixture
 * ids therefore have to be monotonic rather than merely unique.
 */
const nextId = monotonicFactory();

const said = (sessionId: string, role: Turn['role'], body: string): Turn => ({
  id: nextId(),
  sessionId,
  role,
  parts: [{ id: nextId(), kind: 'text', body }],
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
      { sessionId: 's2', model: 'kilo/two', title: 'and a functor', preview: 'ok', updatedAt: 200 },
      {
        sessionId: 's1',
        model: 'kilo/one',
        title: 'what is a monad',
        preview: 'ok',
        updatedAt: 100,
      },
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

  it('reduces a long first message to one short line for the title and the preview', async () => {
    const long = `${'tell me about the composer '.repeat(200)}\nand then some`;
    await write(
      Effect.gen(function* conversing() {
        const store = yield* SessionStore;
        yield* store.create({ id: 'long', system: 'be brief', model: 'kilo/one' });
        yield* store.append({
          sessionId: 'long',
          turns: [said('long', 'user', long)],
          prompted: 10,
        });
        yield* store.flush();
      })
    );
    rememberChat(db, { sessionId: 'long', scope: 'me:personal', at: 1 });

    const [row] = listChats(db, 'me:personal');
    expect(row?.title).toHaveLength(DERIVED_CHAT_TEXT_MAX_LENGTH);
    expect(row?.title.endsWith('…')).toBe(true);
    expect(row?.title.startsWith('tell me about the composer')).toBe(true);
    expect(row?.preview).toBe(row?.title);
  });

  it('shows a name the person gave a long chat exactly as it was typed', async () => {
    const long = 'tell me about the composer '.repeat(200);
    await write(conversation('named', 'kilo/one', long));
    rememberChat(db, { sessionId: 'named', scope: 'me:personal', at: 1 });
    renameChat(db, 'named', '  Composer notes  ');

    expect(listChats(db, 'me:personal')[0]?.title).toBe('  Composer notes  ');
  });
});

describe('toolsOfSession', () => {
  it('answers the names the session was opened with, in the order they were given', async () => {
    await write(
      Effect.gen(function* opening() {
        const store = yield* SessionStore;
        yield* store.create({
          id: 's1',
          system: 'be brief',
          model: 'kilo/one',
          tools: ['time', 'settings_list', 'settings_set'],
        });
        yield* store.flush();
      })
    );

    expect(toolsOfSession(db, 's1')).toEqual(['time', 'settings_list', 'settings_set']);
  });

  it('answers nothing for a session stored without tools, so the caller moves', async () => {
    await write(conversation('s1', 'kilo/one', 'hello'));

    expect(toolsOfSession(db, 's1')).toBeNull();
  });

  it('answers nothing for a session the store never wrote', () => {
    expect(toolsOfSession(db, 'missing')).toBeNull();
  });
});

describe('moveChat', () => {
  it('keeps one row when a chat moves onto another model', async () => {
    await write(conversation('old', 'kilo/one', 'hello'));
    await write(conversation('new', 'kilo/two', 'hello'));
    rememberChat(db, { sessionId: 'old', scope: 'me:personal', at: 100 });

    moveChat(db, { from: 'old', to: 'new', at: 400 });

    expect(listChats(db, 'me:personal')).toEqual([
      { sessionId: 'new', model: 'kilo/two', title: 'hello', preview: 'ok', updatedAt: 400 },
    ]);
    expect(scopeOfChat(db, 'old')).toBeNull();
    expect(scopeOfChat(db, 'new')).toBe('me:personal');
  });

  it('keeps the name a person gave the chat', async () => {
    await write(conversation('old', 'kilo/one', 'hello'));
    await write(conversation('new', 'kilo/two', 'hello'));
    rememberChat(db, { sessionId: 'old', scope: 'me:personal', at: 100 });
    renameChat(db, 'old', 'Greetings');

    moveChat(db, { from: 'old', to: 'new', at: 400 });

    expect(listChats(db, 'me:personal')).toEqual([
      { sessionId: 'new', model: 'kilo/two', title: 'Greetings', preview: 'ok', updatedAt: 400 },
    ]);
  });
});

describe('recordOfChat', () => {
  const used = { inputTokens: 3, outputTokens: 4, cacheReadTokens: 90, cacheWriteTokens: 0 };

  it('reads the start, the usage, and the SDK prompted count back', async () => {
    await write(conversation('s1', 'kilo/one', 'hello'));
    rememberChat(db, { sessionId: 's1', scope: 'me:personal', at: 100 });
    recordUsage(db, 's1', { 'kilo/one': { ...used, cost: 0.01 } });

    expect(recordOfChat(db, 's1')).toEqual({
      createdAt: 100,
      updatedAt: 100,
      usage: { 'kilo/one': { ...used, cost: 0.01 } },
      prompted: 10,
      effort: null,
    });
  });

  it('keeps the start and the usage when a model switch moves the chat', async () => {
    await write(conversation('old', 'kilo/one', 'hello'));
    await write(conversation('new', 'kilo/two', 'hello'));
    rememberChat(db, { sessionId: 'old', scope: 'me:personal', at: 100 });
    recordUsage(db, 'old', { 'kilo/one': used });

    moveChat(db, { from: 'old', to: 'new', at: 400 });

    expect(recordOfChat(db, 'new')).toMatchObject({
      createdAt: 100,
      updatedAt: 400,
      usage: { 'kilo/one': used },
    });
  });

  it('marks a chat that predates the count with no start', async () => {
    await write(conversation('s1', 'kilo/one', 'hello'));
    database
      .prepare("insert into chats (session_id, scope, updated_at) values ('s1', 'me', 5)")
      .run();

    expect(recordOfChat(db, 's1')).toMatchObject({ createdAt: null, usage: {} });
  });

  it('reads a usage column it cannot parse as nothing used', async () => {
    await write(conversation('s1', 'kilo/one', 'hello'));
    rememberChat(db, { sessionId: 's1', scope: 'me:personal', at: 100 });
    database.prepare('update chats set usage = \'{"kilo/one":{"inputTokens":-1}}\'').run();

    expect(recordOfChat(db, 's1').usage).toEqual({});
  });

  it('answers no record for a chat that is not there', () => {
    expect(recordOfChat(db, 'missing')).toBe(NO_RECORD);
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

    await wipeChats(db, 'me');

    expect(listChats(db, 'me:personal')).toEqual([]);
    expect(listChats(db, 'you:personal')).toHaveLength(1);
    expect(database.prepare('select count(*) as n from sessions').get()).toEqual({ n: 1 });
  });

  it('takes every account when the account is unknown', async () => {
    await write(conversation('mine', 'kilo/one', 'hello'));
    await write(conversation('theirs', 'kilo/one', 'hello'));
    rememberChat(db, { sessionId: 'mine', scope: 'me:acme', at: 100 });
    rememberChat(db, { sessionId: 'theirs', scope: 'you:personal', at: 100 });

    await wipeChats(db, null);

    expect(database.prepare('select count(*) as n from chats').get()).toEqual({ n: 0 });
    expect(database.prepare('select count(*) as n from sessions').get()).toEqual({ n: 0 });
  });

  it('keeps another account whose identifier starts the same way', async () => {
    await write(conversation('mine', 'kilo/one', 'hello'));
    await write(conversation('theirs', 'kilo/one', 'hello'));
    rememberChat(db, { sessionId: 'mine', scope: 'me:personal', at: 100 });
    rememberChat(db, { sessionId: 'theirs', scope: 'mendel:personal', at: 100 });

    await wipeChats(db, 'me');

    expect(listChats(db, 'mendel:personal')).toHaveLength(1);
  });

  it('answers with the chats it removed, so their settings go with them', async () => {
    await write(conversation('mine', 'kilo/one', 'hello'));
    await write(conversation('theirs', 'kilo/one', 'hello'));
    rememberChat(db, { sessionId: 'mine', scope: 'me:personal', at: 100 });
    rememberChat(db, { sessionId: 'theirs', scope: 'you:personal', at: 100 });

    expect(await wipeChats(db, 'me')).toEqual(['mine']);
  });

  it('takes every row under both chats of the account, down to their parts', async () => {
    await write(conversation('one', 'kilo/one', 'first'));
    await write(conversation('two', 'kilo/one', 'second'));
    await write(conversation('theirs', 'kilo/one', 'not mine'));
    rememberChat(db, { sessionId: 'one', scope: 'me:personal', at: 100 });
    rememberChat(db, { sessionId: 'two', scope: 'me:acme', at: 200 });
    rememberChat(db, { sessionId: 'theirs', scope: 'you:personal', at: 300 });
    const watched = watchedDatabase(database);

    expect(await wipeChats(watched.db, 'me')).toEqual(['one', 'two']);

    for (const table of ['parts', 'turns']) {
      const wiped = `select count(*) as n from ${table} where session_id in ('one', 'two')`;
      expect(tally(wiped)).toBe(0);
      expect(tally(`select count(*) as n from ${table}`)).toBe(2);
    }
    expect(listChats(db, 'you:personal')).toHaveLength(1);
  });

  it('rolls the whole account back when the database refuses a statement', async () => {
    await write(conversation('one', 'kilo/one', 'first'));
    await write(conversation('two', 'kilo/one', 'second'));
    rememberChat(db, { sessionId: 'one', scope: 'me:personal', at: 100 });
    rememberChat(db, { sessionId: 'two', scope: 'me:personal', at: 200 });
    const rowCounts = () =>
      ['parts', 'turns', 'sessions', 'chats'].map(table =>
        tally(`select count(*) as n from ${table}`)
      );

    await expect(wipeChats(watchedDatabase(database, 3).db, 'me')).rejects.toThrow(
      'the database refused the statement'
    );

    // The refusal landed on the third statement, with the parts of both chats
    // already deleted, and the wipe's own transaction put every row back.
    expect(rowCounts()).toEqual([4, 4, 2, 2]);
    expect(await wipeChats(db, 'me')).toEqual(['one', 'two']);
    expect(rowCounts()).toEqual([0, 0, 0, 0]);
  });

  it('waits for a unit the store left open, and its deletes survive that unit rolling back', async () => {
    await write(conversation('one', 'kilo/one', 'first'));
    await write(conversation('two', 'kilo/one', 'second'));
    rememberChat(db, { sessionId: 'one', scope: 'me:personal', at: 100 });
    rememberChat(db, { sessionId: 'two', scope: 'me:personal', at: 200 });
    /* The store writes an exchange between a `BEGIN` and its `COMMIT`, and an
       interrupted answer stops the fiber waiting on that write without stopping
       the write. What is left is an open transaction on the connection the wipe
       uses. The wipe waits for it to close, so what it deletes is its own unit
       and not a passenger of that write. */
    database.exec('begin');
    database
      .prepare('insert into turns (id, session_id, role) values (?, ?, ?)')
      .run('trn_pending', 'one', 'user');
    const storeUnit = Promise.withResolvers<undefined>();
    const closing = (async () => {
      await storeUnit.promise;
      database.exec('rollback');
    })();

    const wiping = wipeChats(db, 'me');
    /* The store's write is unfinished while the wipe is asked, so the wipe has
       not deleted anything yet: a delete inside that unit would be undone with
       it, and the account's conversations would come back on the next launch. */
    expect(database.isTransaction).toBe(true);
    storeUnit.resolve(undefined);
    await closing;

    expect(await wiping).toEqual(['one', 'two']);
    for (const table of ['chats', 'sessions', 'turns', 'parts']) {
      expect(tally(`select count(*) as n from ${table}`)).toBe(0);
    }
  });

  it('refuses to wipe inside a store unit that never closes', async () => {
    await write(conversation('one', 'kilo/one', 'first'));
    rememberChat(db, { sessionId: 'one', scope: 'me:personal', at: 100 });
    database.exec('begin');
    try {
      await expect(wipeChats(db, 'me')).rejects.toThrow(
        'the store did not finish its write, so the chats were not wiped'
      );
      // Nothing was deleted, so the account is whole and the next sign-out
      // retries it.
      expect(tally('select count(*) as n from chats')).toBe(1);
    } finally {
      database.exec('rollback');
    }
  });

  it('runs one statement per table however many chats the account has', async () => {
    await write(conversation('a', 'kilo/one', 'hello'));
    await write(conversation('b', 'kilo/one', 'hello'));
    await write(conversation('c', 'kilo/one', 'hello'));
    for (const sessionId of ['a', 'b', 'c']) {
      rememberChat(db, { sessionId, scope: 'me:personal', at: 100 });
    }
    const watched = watchedDatabase(database);

    // A statement per table, not per chat, is what keeps a sign-out from
    // blocking the thread in proportion to how much history the account has.
    expect(await wipeChats(watched.db, 'me')).toEqual(['a', 'b', 'c']);
    expect(watched.counts.statements).toHaveLength(4);
    expect(watched.counts.transactions).toBe(1);
    /* The ids are read inside the unit that deletes them, so a chat that lands
       between the read and the deletes cannot be deleted without being named —
       its pending question and its settings are dropped by the ids the wipe
       answers, and one missing there outlives the account. */
    expect(watched.counts.reads).toEqual([1]);
    for (const table of ['chats', 'sessions', 'turns', 'parts']) {
      expect(tally(`select count(*) as n from ${table}`)).toBe(0);
    }
  });
});
