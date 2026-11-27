import pg from 'pg';
import { z } from 'zod';

/**
 * Identity-store access for the UTS Workers, through Hyperdrive with `pg`, the driver that
 * Cloudflare recommends for Hyperdrive and that the rest of this repository uses.
 *
 * Rules (design section 5.2):
 * * One `pg.Client` per request; Hyperdrive owns the connection pool.
 * * The Hyperdrive configs for the identity store run with caching disabled, so every read here
 *   reaches Postgres.
 * * Every call sends exactly one SQL statement over the extended protocol, which rejects a second
 *   statement, and transaction-control statements are refused. A mint, refresh or revoke is one
 *   statement that calls a stored function, so it never holds a transaction open across round
 *   trips through Hyperdrive.
 */

/** `pg_type.oid` values that `pg` does not decode as needed here. */
const INT8_OID = 20;
const XID8_OID = 5069;

/** `int8` and `xid8` decode to `bigint`; every other type keeps `pg`'s own parser. */
export const identityStoreTypes: pg.CustomTypesConfig = {
  getTypeParser: (oid, format): ((value: string) => unknown) => {
    const typeOid: number = oid;
    if ((typeOid === INT8_OID || typeOid === XID8_OID) && (format ?? 'text') === 'text') {
      return (value: string) => BigInt(value);
    }
    // pg types every parser as `(value: string) => any`; callers only invoke the result.
    return pg.types.getTypeParser(oid, format) as (value: string) => unknown;
  },
};

declare module 'pg' {
  // The type parameter mirrors the declaration in `@types/pg`; merged declarations must match.
  interface QueryConfig<I> {
    /**
     * `pg` reads this option at run time (`pg/lib/query.js`), but `@types/pg` does not declare it.
     * `'extended'` sends the statement over the extended protocol even without parameters, so the
     * server refuses a second statement in the same text.
     */
    queryMode?: 'extended';
  }
}

export type Statement = { text: string; values: readonly unknown[] };

const TRANSACTION_CONTROL =
  /^\s*(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b/i;

/**
 * `retryable`: the database or the connection failed and the same statement can succeed later
 * (connection loss, too many connections, a lock or statement timeout, a serialization failure).
 * `permanent`: the statement itself was refused (a constraint, a privilege, bad input).
 */
export type IdentityStoreFailure = 'retryable' | 'permanent';

/** What the server or the driver said about a failure, without the row values it may quote. */
export type IdentityStoreErrorDetails = {
  sqlState: string | undefined;
  constraint: string | undefined;
  table: string | undefined;
  /** The Node or TLS error code of a failed connection, such as `ECONNREFUSED` or `ETIMEDOUT`. */
  systemCode: string | undefined;
};

/**
 * Keeps only the SQLSTATE, the constraint name, the table name and a connection failure's system
 * code. The server's error detail ("Failing row contains ...") can hold an email address, a client
 * address or a hash, so neither it nor the raw driver error travels with this error into a log or
 * an error report.
 */
export class IdentityStoreError extends Error {
  override name = 'IdentityStoreError';
  readonly failure: IdentityStoreFailure;
  /** The PostgreSQL SQLSTATE, when the server answered with one. */
  readonly sqlState: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly systemCode: string | undefined;

  constructor(failure: IdentityStoreFailure, details: IdentityStoreErrorDetails) {
    const code = details.sqlState ?? details.systemCode;
    super(`identity store ${failure} failure${code === undefined ? '' : ` (${code})`}`);
    this.failure = failure;
    this.sqlState = details.sqlState;
    this.constraint = details.constraint;
    this.table = details.table;
    this.systemCode = details.systemCode;
  }
}

export class TransactionStatementError extends Error {
  override name = 'TransactionStatementError';
  constructor() {
    super('identity-store statements run outside multi-statement transactions');
  }
}

const RETRYABLE_SQLSTATE = /^(08|53|57P0)|^(40001|40P01|55P03|57014|25P03)$/;

/** A Node system or TLS error code: upper-case letters, digits and underscores only. */
const SystemErrorSchema = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) });

function toIdentityStoreError(error: unknown): IdentityStoreError {
  if (error instanceof pg.DatabaseError) {
    const sqlState = error.code;
    const failure =
      sqlState !== undefined && RETRYABLE_SQLSTATE.test(sqlState) ? 'retryable' : 'permanent';
    return new IdentityStoreError(failure, {
      sqlState,
      constraint: error.constraint,
      table: error.table,
      systemCode: undefined,
    });
  }
  // No SQLSTATE: the connection failed before or during the statement.
  return new IdentityStoreError('retryable', {
    sqlState: undefined,
    constraint: undefined,
    table: undefined,
    systemCode: SystemErrorSchema.safeParse(error).data?.code,
  });
}

export class IdentityStore {
  readonly #client: pg.Client;

  constructor(client: pg.Client) {
    this.#client = client;
  }

  /** Runs one statement and validates every returned row. */
  async rows<Row extends z.ZodType>(statement: Statement, row: Row): Promise<z.output<Row>[]> {
    if (TRANSACTION_CONTROL.test(statement.text)) throw new TransactionStatementError();
    let result: pg.QueryResult;
    try {
      result = await this.#client.query({
        text: statement.text,
        values: [...statement.values],
        queryMode: 'extended',
      });
    } catch (error) {
      throw toIdentityStoreError(error);
    }
    return result.rows.map(value => row.parse(value));
  }

  /** Runs one statement that returns no row or one row. */
  async maybeOne<Row extends z.ZodType>(
    statement: Statement,
    row: Row
  ): Promise<z.output<Row> | null> {
    const rows = await this.rows(statement, row);
    if (rows.length > 1) throw new Error(`expected at most one row, got ${rows.length}`);
    return rows[0] ?? null;
  }
}

/** The part of a Worker's `ExecutionContext` this module uses. */
export type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

/**
 * Opens one connection for one request, runs `work`, and closes the connection in the
 * background. `connectionString` is a Hyperdrive binding's `connectionString`. A caller that must
 * not wait on a hung connect passes `connectionTimeoutMillis`; a timed-out connect is retryable.
 */
export async function withIdentityStore<Result>(
  connectionString: string,
  context: WaitUntil,
  work: (store: IdentityStore) => Promise<Result>,
  options: { connectionTimeoutMillis?: number } = {}
): Promise<Result> {
  const client = new pg.Client({ connectionString, types: identityStoreTypes, ...options });
  try {
    await client.connect();
  } catch (error) {
    throw toIdentityStoreError(error);
  }
  try {
    return await work(new IdentityStore(client));
  } finally {
    context.waitUntil(client.end());
  }
}
