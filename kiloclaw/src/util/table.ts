/* eslint-disable @typescript-eslint/no-explicit-any */

import type { z } from 'zod';

export type TableInput = {
  name: string;
  columns: readonly string[];
};

export type TableQueryInterpolator<T extends TableInput> = {
  _name: T['name'];
  columns: {
    [K in T['columns'][number]]: K;
  };
  valueOf: () => T['name'];
  toString: () => T['name'];
} & {
  [K in T['columns'][number]]: `${T['name']}.${K}`;
};

/**
 * Get a convenient object for interpolating a sql table name and columns
 * into a template string.
 *
 * @example
 * const users = getTable({ name: 'users', columns: ['id', 'email'] as const })
 * const query = `SELECT ${users.email} FROM ${users} WHERE ${users.id} = $1`
 */
export function getTable<T extends TableInput>(table: T): TableQueryInterpolator<T> {
  const columns: {
    [K in T['columns'][number]]: K;
  } = {} as any;

  const columnsWithTable: {
    [K in T['columns'][number]]: `${T['name']}.${K}`;
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
 * Get a table interpolator from a Zod object schema.
 *
 * @example
 * const UserRecord = z.object({ id: z.string(), email: z.string() })
 * const users = getTableFromZodSchema('users', UserRecord)
 * const query = `SELECT ${users.email} FROM ${users} WHERE ${users.id} = $1`
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
