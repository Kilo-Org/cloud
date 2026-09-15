import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { Effect, Layer, Option } from 'effect';
import {
  SessionStore,
  StoreError,
  type SessionStoreService,
  type StoredExchange,
} from '../../core/storage.js';
import type { Turn, TurnPart } from '../../core/turn.js';
import { connectionOf, transact, type Connection, type SqlDriver } from './driver.js';
import { migrate } from './migrate.js';
import {
  assertParts,
  assertSessions,
  assertTurns,
  asStoredSession,
  byTurn,
  toolsIn,
} from './rows.js';
import { parts, sessions, turns } from './schema.js';

/**
 * The SQLite store, written once for every platform. It holds every query.
 *
 * The seam is `driver.ts`: one function, so `node:sqlite` and Expo each need an
 * adapter of about twenty lines and share all of this. What a row means is
 * `rows.ts`, and how the tables come to exist is `migrate.ts`.
 */

const failing = (operation: StoreError['operation']) => (cause: unknown) =>
  new StoreError({ operation, cause });

const attempt = <A>(
  operation: StoreError['operation'],
  run: () => Promise<A>
): Effect.Effect<A, StoreError> => Effect.tryPromise({ try: run, catch: failing(operation) });

type Db = ReturnType<typeof drizzle>;

/** What only one kind of part carries. Everything else leaves the column empty. */
const columnsOf = (part: TurnPart) => {
  switch (part.kind) {
    case 'image': {
      return { media: part.media };
    }
    case 'reasoning': {
      return part.signature === undefined ? {} : { signature: part.signature };
    }
    case 'toolCall': {
      return { callId: part.callId, name: part.name };
    }
    case 'toolResult': {
      return { callId: part.callId, failed: part.failed };
    }
    case 'text':
    case 'summary':
    case 'redacted': {
      return {};
    }
  }
};

/** One part, as its row. Only the kind that has a column fills it. */
const partRow = (turn: Turn, part: TurnPart) => ({
  id: part.id,
  turnId: turn.id,
  sessionId: turn.sessionId,
  kind: part.kind,
  body: part.body,
  ...columnsOf(part),
});

/**
 * Writes the turns, their parts, and the session's new count as one unit. A
 * turn whose parts went missing would read back as an empty message and quietly
 * shorten the prompt, a question written without its answer would go back out
 * with every later request, and a count written apart from either would say the
 * session holds something it does not.
 */
const insertExchange = (connection: Connection, db: Db, exchange: StoredExchange): Promise<void> =>
  transact(connection, async () => {
    const written = exchange.turns;
    if (written.length > 0) {
      await db
        .insert(turns)
        .values(written.map(turn => ({ id: turn.id, sessionId: turn.sessionId, role: turn.role })));
      const rows = written.flatMap(turn => turn.parts.map(part => partRow(turn, part)));
      if (rows.length > 0) {
        await db.insert(parts).values(rows);
      }
    }
    await db
      .update(sessions)
      .set({ prompted: exchange.prompted })
      .where(eq(sessions.id, exchange.sessionId));
  });

/**
 * Two indexed scans and no join. Both tables carry the session, so each read is
 * a range over one index and the parts are matched up in memory, in one pass.
 */
const selectTurns = async (db: Db, sessionId: string): Promise<readonly Turn[]> => {
  const [turnRows, partRows] = await Promise.all([
    db.select().from(turns).where(eq(turns.sessionId, sessionId)).orderBy(asc(turns.id)),
    db.select().from(parts).where(eq(parts.sessionId, sessionId)).orderBy(asc(parts.id)),
  ]);
  const held = byTurn(assertParts(partRows));
  return assertTurns(turnRows).map(
    (turn): Turn => ({
      id: turn.id,
      sessionId: turn.sessionId,
      role: turn.role,
      parts: held.get(turn.id) ?? [],
    })
  );
};

/**
 * Builds the store on a driver. Every write lands at once, so `flush` has
 * nothing to do: batching would trade a lost turn for a saving this package has
 * not measured a need for.
 */
const storeOn = (connection: Connection): SessionStoreService => {
  const db = drizzle(connection.driver);

  return {
    create: session =>
      attempt('create', () =>
        connection.write(async () => {
          await db.insert(sessions).values({ ...session, tools: toolsIn(session.tools) });
        })
      ),

    read: sessionId =>
      attempt('read', async () => {
        const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        return Option.map(Option.fromNullable(assertSessions(rows)[0]), asStoredSession);
      }),

    append: exchange => attempt('append', () => insertExchange(connection, db, exchange)),

    load: sessionId => attempt('load', () => selectTurns(db, sessionId)),

    flush: () => Effect.void,
  };
};

/**
 * Opens the store: migrates, then hands back the plugin. Migrating here rather
 * than on first use means a database that cannot be migrated fails when the
 * layer is built, not on the first question somebody asks.
 */
const layerSqliteStore = (driver: SqlDriver): Layer.Layer<SessionStore, StoreError> =>
  Layer.suspend(() => {
    const connection = connectionOf(driver);
    return Layer.effect(
      SessionStore,
      Effect.map(
        attempt('create', async () => {
          await driver('PRAGMA foreign_keys = ON', [], 'run');
          await migrate(connection);
        }),
        () => storeOn(connection)
      )
    );
  });

export { layerSqliteStore };
