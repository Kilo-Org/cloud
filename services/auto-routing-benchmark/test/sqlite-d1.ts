import { readFileSync, readdirSync } from 'node:fs';
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { URL } from 'node:url';

type SqliteD1Result = {
  success: true;
  results: Record<string, SQLOutputValue>[];
  meta: { changes: number; last_row_id: number };
};

export function applyBenchmarkMigrations(sqlite: DatabaseSync) {
  const directory = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(directory)
    .filter(name => name.endsWith('.sql'))
    .sort()) {
    sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
  }
}

export function sqliteD1(sqlite: DatabaseSync): D1Database {
  const executions = new WeakMap<D1PreparedStatement, () => SqliteD1Result>();

  function query(sqlText: string, params: SQLInputValue[]) {
    const statement = sqlite.prepare(sqlText);
    // node:sqlite names ?NNN bindings; D1 binds those same parameters by numeric position.
    const numbered = new Set([...sqlText.matchAll(/\?(\d+)/g)].map(match => Number(match[1])));
    const named: Record<string, SQLInputValue> = {};
    for (const number of numbered) {
      const value = params[number - 1];
      if (value === undefined) throw new Error(`Missing SQLite binding ?${number}`);
      named[`?${number}`] = value;
    }
    const results =
      numbered.size === 0
        ? statement.all(...params)
        : statement.all(named, ...params.filter((_, index) => !numbered.has(index + 1)));
    return { statement, results };
  }

  function execute(sqlText: string, params: SQLInputValue[]): SqliteD1Result {
    const { results } = query(sqlText, params);
    const metadata = sqlite
      .prepare('SELECT changes() AS changes, last_insert_rowid() AS last_row_id')
      .get();
    if (!metadata) throw new Error('SQLite did not return statement metadata');
    return {
      success: true,
      results,
      meta: { changes: Number(metadata.changes), last_row_id: Number(metadata.last_row_id) },
    };
  }

  function prepare(sqlText: string, params: SQLInputValue[] = []): D1PreparedStatement {
    const statement = {
      bind(...values: SQLInputValue[]) {
        if (values.length > 100)
          throw new Error('D1 statements cannot bind more than 100 variables');
        return prepare(sqlText, values);
      },
      async run() {
        return execute(sqlText, params);
      },
      async all() {
        return execute(sqlText, params);
      },
      async first(column?: string) {
        const row = execute(sqlText, params).results[0];
        return row ? (column === undefined ? row : row[column]) : null;
      },
      async raw(options?: { columnNames?: boolean }) {
        const { statement: prepared, results } = query(sqlText, params);
        const rows = results.map(row => Object.values(row));
        return options?.columnNames
          ? [prepared.columns().map(column => column.name), ...rows]
          : rows;
      },
    } as D1PreparedStatement;
    executions.set(statement, () => execute(sqlText, params));
    return statement;
  }

  return {
    prepare,
    async batch(statements: D1PreparedStatement[]) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => {
          const run = executions.get(statement);
          if (!run) throw new Error('Cannot batch a statement from another SQLite D1 binding');
          return run();
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sqlText: string) {
      sqlite.exec(sqlText);
      return { count: 1, duration: 0 };
    },
  } as D1Database;
}
