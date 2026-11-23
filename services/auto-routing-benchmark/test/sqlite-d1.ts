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

/** `onRoundTrip` runs before every statement or batch reaches SQLite, as one D1 call. */
export function sqliteD1(sqlite: DatabaseSync, onRoundTrip: () => void = () => {}): D1Database {
  const executions = new WeakMap<D1PreparedStatement, () => SqliteD1Result>();

  function query(sqlText: string, params: SQLInputValue[]) {
    // D1 rejects a statement whose bind count does not match its placeholders
    // (`D1_ERROR: wrong number of bindings`). node:sqlite silently treats an unbound
    // trailing parameter as NULL, which would hide exactly that class of bug, so the
    // harness enforces the production contract before preparing.
    const numbered = new Set<number>();
    let placeholders = 0;
    for (const match of sqlText.matchAll(
      /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\?(\d*)/g
    )) {
      const index = match[1];
      if (index === undefined) continue;
      if (index === '') {
        placeholders += 1;
      } else {
        const position = Number(index);
        numbered.add(position);
        placeholders = Math.max(placeholders, position);
      }
    }
    if (params.length !== placeholders)
      throw new Error(
        `statement has ${placeholders} placeholders but ${params.length} values were bound`
      );
    const statement = sqlite.prepare(sqlText);
    // node:sqlite names ?NNN bindings; D1 binds those same parameters by numeric position.
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
    // D1 rejects a statement that binds more than 100 parameters ("too many SQL variables"),
    // and so does production: a staging slice once bound one value per case and exceeded it on
    // a wide pool. The harness must fail the same way instead of accepting what D1 refuses.
    if (params.length > 100)
      throw new Error(
        `D1 statements cannot bind more than 100 parameters (this one binds ${params.length})`
      );
    const statement = {
      bind(...values: SQLInputValue[]) {
        return prepare(sqlText, values);
      },
      async run() {
        onRoundTrip();
        return execute(sqlText, params);
      },
      async all() {
        onRoundTrip();
        return execute(sqlText, params);
      },
      async first(column?: string) {
        onRoundTrip();
        const row = execute(sqlText, params).results[0];
        return row ? (column === undefined ? row : row[column]) : null;
      },
      async raw(options?: { columnNames?: boolean }) {
        onRoundTrip();
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
      onRoundTrip();
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
