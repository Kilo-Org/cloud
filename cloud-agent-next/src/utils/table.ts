/* eslint-disable @typescript-eslint/no-explicit-any */

import type { z } from 'zod';

export interface TableInput {
  name: string;
  columns: readonly string[];
}

export type TableQueryInterpolator<T extends TableInput> = {
  // The name of the table. Prefixed with underscore to avoid
  // conflicting with a column named "name"
  _name: T['name'];
  // Holds the un-prefixed version of column names e.g. "id"
  // Use in INSERT/UPDATE column lists where qualified names are invalid
  columns: {
    [K in T['columns'][number]]: K;
  };
  // The valueOf and toString functions ensure that when using
  // this object as a regular value, it gets turned into the
  // the name of the table
  valueOf: () => T['name'];
  toString: () => T['name'];
} & {
  // Mix-in prefixed versions of columns e.g. "users.id"
  // Use in SELECT, WHERE, ORDER BY, JOIN clauses
  [K in T['columns'][number]]: `${T['name']}.${K}`;
};

/**
 * Get a convenient object for interpolating a sql table name and columns
 * into a template string.
 *
 * @example
 * const users = getTable({ name: 'users', columns: ['id', 'email'] as const });
 *
 * // Use table.columns.* for INSERT column lists (unqualified)
 * const { columns: cols } = users;
 * sql.exec(`INSERT INTO ${users} (${cols.id}, ${cols.email}) VALUES (?, ?)`, ...);
 *
 * // Use table.* for SELECT/WHERE/ORDER (qualified)
 * sql.exec(`SELECT ${users.email} FROM ${users} WHERE ${users.id} = ?`, ...);
 *
 * @param table Table description with name and columns
 */
export function getTable<T extends TableInput>(table: T): TableQueryInterpolator<T> {
  const columns: {
    [K in T['columns'][number]]: K;
    // Need any type here because we populate this object in the loop below
  } = {} as any;

  const columnsWithTable: {
    [K in T['columns'][number]]: `${T['name']}.${K}`;
    // Need any type here because we populate this object in the loop below
  } = {} as any;

  for (const key of table.columns) {
    (columns as any)[key] = key;

    (columnsWithTable as any)[key] = [table.name, key].join('.');
  }

  const result: TableQueryInterpolator<T> = {
    _name: table.name,
    valueOf() {
      return table.name;
    },
    toString() {
      return table.name;
    },
    columns,
    ...columnsWithTable,
  };

  return result;
}

/**
 * Get a convenient object for interpolating a sql table name and columns
 * into a template string from a Zod Object schema.
 *
 * @example
 * const UserRecord = z.object({ id: z.string(), email: z.string() });
 * const users = getTableFromZodSchema('users', UserRecord);
 *
 * // Use table.columns.* for INSERT column lists (unqualified)
 * const { columns: cols } = users;
 * sql.exec(`INSERT INTO ${users} (${cols.id}, ${cols.email}) VALUES (?, ?)`, ...);
 *
 * // Use table.* for SELECT/WHERE/ORDER (qualified)
 * sql.exec(`SELECT ${users.email} FROM ${users} WHERE ${users.id} = ?`, ...);
 *
 * @param name The name of your table
 * @param schema The Zod object schema
 */
export function getTableFromZodSchema<Name extends string, Schema extends z.ZodObject<any>>(
  name: Name,
  schema: Schema
): TableQueryInterpolator<{
  name: Name;
  columns: Array<Extract<keyof z.infer<Schema>, string>>;
}> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return getTable({ name, columns: Object.keys(schema.shape) }) as any;
}

// Note: getCreateTableQueryFromTable is omitted since we keep migrations.ts as raw SQL
