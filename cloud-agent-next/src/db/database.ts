/**
 * This module serves as a [facade](https://en.wikipedia.org/wiki/Facade_pattern)
 * to underlying postgres drivers (node-postgres, postgres.js). We are currently
 * using node-postgres but we previously used postgres.js. In order to aide in the
 * migration to node-postgres, we created this common interface module for creating
 * generic "Database" connections which wrap either node-postgres or postgres.js.
 * While we currently only use node-postgres, this same pattern could be applied
 * to a range of databases, including d1 or sqlite in DO's
 */

import { createNodePostgresConnection } from './node-postgres.js';

/**
 * The primary interface into a database
 */
export type Database = {
  __kind: 'Database';

  /**
   * Query the database connection
   */
  query: <Query extends string>(text: Query, values: QueryParams<Query>) => Promise<unknown[]>;

  /**
   * Begin a transaction. All code executed inside of transactionFn are performed
   * within the context of the transaction
   */
  begin: <T>(transactionFn: (tx: Transaction) => Promise<T>) => Promise<T>;

  /**
   * End a database connection. This function is for compatibility with postgres.js
   * and is typically not used with node-postgres
   */
  end: () => Promise<void>;
};

export type Transaction = Pick<Database, 'query'> & {
  __kind: 'Transaction';
  rollback: () => Promise<void>;
};

// Query helper types
type Separator = '\n' | ' ';

type Trim<T extends string, Acc extends string = ''> = T extends `${infer Char}${infer Rest}`
  ? Char extends Separator
    ? Trim<Rest, Acc>
    : Trim<Rest, `${Acc}${Char}`>
  : T extends ''
    ? Acc
    : never;

/**
 * Recursively extracts numbered parameters (e.g. $1, $2...) from a
 * sql query string and collects them into a tuple (e.g. ['1', '2'])
 */
export type QueryStringParams<
  T extends string,
  ExistingParams extends string[] = [],
> = T extends `${string}$${number}${number}${string}`
  ? T extends `${string}$${infer NextParamDigit1}${infer NextParamDigit2}${infer Rest extends string}`
    ? Rest extends string
      ? QueryStringParams<
          Rest,
          [...ExistingParams, `${Trim<NextParamDigit1>}${Trim<NextParamDigit2>}`]
        >
      : [...ExistingParams, `${Trim<NextParamDigit1>}${Trim<NextParamDigit2>}`]
    : ExistingParams
  : T extends `${string}$${number}${string}`
    ? T extends `${string}$${infer NextParam}${infer Rest extends string}`
      ? Rest extends string
        ? QueryStringParams<Rest, [...ExistingParams, NextParam]>
        : [...ExistingParams, NextParam]
      : ExistingParams
    : ExistingParams;

export type QueryParams<Query extends string> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in QueryStringParams<Query>[number]]: any;
};

export type CreateDatabaseConnection = (connectionString: string) => Database;

/**
 * The canoical createDatabaseConnection. Currently is pointing to the node-postgres.connection.
 * If we decided we want to change out drivers across all of banda-infra, we'd update this
 * function to point to the other driver.
 */
export const createDatabaseConnection: CreateDatabaseConnection = connectionString =>
  createNodePostgresConnection(connectionString);
