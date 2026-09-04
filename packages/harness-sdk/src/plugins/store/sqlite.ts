import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { Effect, Layer, Option } from 'effect';
import { assert, createAssert } from 'typia';
import type { Effort } from '../../core/model.js';
import {
  SessionStore,
  StoreError,
  type SessionStoreService,
  type StoredSession,
} from '../../core/storage.js';
import type { Turn, TurnPart, TurnRole } from '../../core/turn.js';
import { migrations } from './migrations.js';
import { parts, sessions, turns } from './schema.js';

/**
 * The SQLite store, written once for every platform.
 *
 * A driver supplies one function: run this SQL with these parameters and give
 * back the rows. That is the whole seam, so `node:sqlite` and Expo each need an
 * adapter of about twenty lines and share every query below.
 *
 * The rows are asserted rather than trusted. Drizzle types state what the
 * schema declares, not what the file on disk holds: a database written by an
 * older build, or by another program, still arrives as `unknown`.
 */

/** What this store binds to a statement. It holds text and numbers, nothing else. */
type SqlValue = string | number | null;

/**
 * Rows come back by position, not by name, which is the shape drizzle maps onto
 * the selected columns.
 */
type SqlDriver = (
  sql: string,
  params: readonly SqlValue[],
  method: 'run' | 'all' | 'values' | 'get'
) => Promise<{ rows: unknown[] }>;

/** The rows this store reads back, stated so they can be validated at the edge. */
interface SessionRow {
  readonly id: string;
  readonly system: string;
  readonly model: string;
  readonly effort: Effort | null;
  readonly maxTokens: number | null;
}

interface TurnRow {
  readonly id: string;
  readonly sessionId: string;
  readonly role: TurnRole;
}

interface PartRow {
  readonly id: string;
  readonly turnId: string;
  readonly kind: TurnPart['kind'];
  readonly body: string;
  readonly media: string | null;
}

const assertSessions = createAssert<readonly SessionRow[]>();
const assertTurns = createAssert<readonly TurnRow[]>();
const assertParts = createAssert<readonly PartRow[]>();

/**
 * A row is one part, and only an image names a media type. A row that claims to
 * be an image without one is a row this package did not write, so it is refused
 * rather than repaired.
 */
const asPart = (row: PartRow): TurnPart => {
  if (row.kind !== 'image') {
    return { id: row.id, kind: row.kind, body: row.body };
  }
  if (row.media === null) {
    throw new Error(`the image part ${row.id} names no media type`);
  }
  return { id: row.id, kind: 'image', body: row.body, media: row.media };
};

/** Groups the parts by turn in one pass, so joining them back on costs no scan. */
const byTurn = (rows: readonly PartRow[]): Map<string, TurnPart[]> => {
  const held = new Map<string, TurnPart[]>();
  for (const row of rows) {
    const already = held.get(row.turnId);
    const part = asPart(row);
    if (already === undefined) {
      held.set(row.turnId, [part]);
    } else {
      already.push(part);
    }
  }
  return held;
};

/** A column with no value is a value the caller never named, which is absent here. */
const asStoredSession = (row: SessionRow): StoredSession => ({
  id: row.id,
  system: row.system,
  model: row.model,
  ...(row.effort === null ? {} : { effort: row.effort }),
  ...(row.maxTokens === null ? {} : { maxTokens: row.maxTokens }),
});

const failing = (operation: StoreError['operation']) => (cause: unknown) =>
  new StoreError({ operation, cause });

const attempt = <A>(
  operation: StoreError['operation'],
  run: () => Promise<A>
): Effect.Effect<A, StoreError> => Effect.tryPromise({ try: run, catch: failing(operation) });

/**
 * How many migrations this database has had, held in SQLite's own
 * `user_version`. It costs no table of our own and no query on the read path.
 */
const versionOf = async (driver: SqlDriver): Promise<number> => {
  const { rows } = await driver('PRAGMA user_version', [], 'get');
  return assert<readonly number[]>(rows)[0] ?? 0;
};

/** Runs the statements in order. A migration that reorders is a migration that fails. */
const runAll = async (driver: SqlDriver, statements: readonly string[]): Promise<void> => {
  const [first, ...rest] = statements;
  if (first === undefined) {
    return;
  }
  await driver(first, [], 'run');
  await runAll(driver, rest);
};

/**
 * Applies every migration the database has not seen, then records how far it
 * got. The version is written into the statement rather than bound, because
 * SQLite allows no parameter in a pragma. The value is this array's length,
 * never anything a caller supplies.
 */
const applyPending = async (driver: SqlDriver, applied: number): Promise<void> => {
  await runAll(driver, migrations.slice(applied).flat());
  await driver(`PRAGMA user_version = ${String(migrations.length)}`, [], 'run');
};

/** Runs the work as one unit, so a process that dies part way leaves nothing half done. */
const transact = async (driver: SqlDriver, run: () => Promise<void>): Promise<void> => {
  await driver('BEGIN', [], 'run');
  try {
    await run();
    await driver('COMMIT', [], 'run');
  } catch (error) {
    await driver('ROLLBACK', [], 'run');
    throw error;
  }
};

/** Migrates in one unit, so the version and the schema always agree. */
const migrate = async (driver: SqlDriver): Promise<void> => {
  const applied = await versionOf(driver);
  if (applied >= migrations.length) {
    return;
  }
  await transact(driver, () => applyPending(driver, applied));
};

type Db = ReturnType<typeof drizzle>;

/** One part, as its row. */
const partRow = (turn: Turn, part: TurnPart) => ({
  id: part.id,
  turnId: turn.id,
  sessionId: turn.sessionId,
  kind: part.kind,
  body: part.body,
  ...(part.kind === 'image' ? { media: part.media } : {}),
});

/**
 * Writes the turns and their parts as one unit. A turn whose parts went missing
 * would read back as an empty message and quietly shorten the prompt, and a
 * question written without its answer would go back out with every later
 * request.
 */
const insertTurns = (db: Db, driver: SqlDriver, written: readonly Turn[]): Promise<void> =>
  transact(driver, async () => {
    if (written.length === 0) {
      return;
    }
    await db
      .insert(turns)
      .values(written.map(turn => ({ id: turn.id, sessionId: turn.sessionId, role: turn.role })));
    const rows = written.flatMap(turn => turn.parts.map(part => partRow(turn, part)));
    if (rows.length > 0) {
      await db.insert(parts).values(rows);
    }
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
const storeOn = (driver: SqlDriver): SessionStoreService => {
  const db = drizzle(driver);

  return {
    create: session =>
      attempt('create', async () => {
        await db.insert(sessions).values(session);
      }),

    read: sessionId =>
      attempt('read', async () => {
        const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        return Option.map(Option.fromNullable(assertSessions(rows)[0]), asStoredSession);
      }),

    append: written => attempt('append', () => insertTurns(db, driver, written)),

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
  Layer.effect(
    SessionStore,
    Effect.map(
      attempt('create', async () => {
        await driver('PRAGMA foreign_keys = ON', [], 'run');
        await migrate(driver);
      }),
      () => storeOn(driver)
    )
  );

export type { SqlDriver, SqlValue };
export { layerSqliteStore };
