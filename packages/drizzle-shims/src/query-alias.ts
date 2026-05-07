/**
 * Aliases `_query` to `query` on every drizzle db (and transaction) instance,
 * in preparation for the drizzle v1 migration where the RQB namespace is being
 * renamed.
 *
 * This module has a side effect: importing it patches `PgDatabase.prototype`
 * and `BaseSQLiteDatabase.prototype` with a `_query` getter that returns
 * `this.query`. Since `PgTransaction` / `SQLiteTransaction` extend the
 * database base classes, transactions (`tx._query`) are covered too.
 *
 * Every entry point that constructs or uses a drizzle db should import this
 * module for its side effect. New code should read from `_query` only; the
 * `drizzle/prefer-underscore-query` oxlint rule enforces that. Once drizzle
 * v1 lands, delete this module and the imports.
 */

import { PgDatabase } from 'drizzle-orm/pg-core';
import { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type { PgQueryResultHKT } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations, TablesRelationalConfig } from 'drizzle-orm';

for (const proto of [PgDatabase.prototype, BaseSQLiteDatabase.prototype]) {
  if (!Object.prototype.hasOwnProperty.call(proto, '_query')) {
    Object.defineProperty(proto, '_query', {
      get(this: { query: unknown }) {
        return this.query;
      },
      configurable: true,
      enumerable: false,
    });
  }
}

declare module 'drizzle-orm/pg-core' {
  interface PgDatabase<
    TQueryResult extends PgQueryResultHKT,
    TFullSchema extends Record<string, unknown> = Record<string, never>,
    TSchema extends TablesRelationalConfig = ExtractTablesWithRelations<TFullSchema>,
  > {
    _query: PgDatabase<TQueryResult, TFullSchema, TSchema>['query'];
  }
}

declare module 'drizzle-orm/sqlite-core' {
  interface BaseSQLiteDatabase<
    TResultKind extends 'sync' | 'async',
    TRunResult,
    TFullSchema extends Record<string, unknown> = Record<string, never>,
    TSchema extends TablesRelationalConfig = ExtractTablesWithRelations<TFullSchema>,
  > {
    _query: BaseSQLiteDatabase<TResultKind, TRunResult, TFullSchema, TSchema>['query'];
  }
}
