/**
 * Database facade following the service pattern from
 * cloudflare-webhook-agent-ingest/src/db/database.ts.
 *
 * Designed for Hyperdrive: each query creates a fresh pg.Client connection.
 * Hyperdrive handles connection pooling transparently at the infrastructure level.
 */

import { createNodePostgresConnection } from './node-postgres';

/**
 * The primary interface into a database.
 */
export type Database = {
  __kind: 'Database';

  query: <Query extends string>(text: Query, values: QueryParams<Query>) => Promise<unknown[]>;

  begin: <T>(transactionFn: (tx: Transaction) => Promise<T>) => Promise<T>;

  end: () => Promise<void>;
};

export type Transaction = Pick<Database, 'query'> & {
  __kind: 'Transaction';
  rollback: () => Promise<void>;
};

// Query helper types -- statically extracts $1, $2 etc. from SQL strings
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

export const createDatabaseConnection: CreateDatabaseConnection = connectionString =>
  createNodePostgresConnection(connectionString);
