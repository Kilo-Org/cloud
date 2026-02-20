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

export function getTableFromZodSchema<Name extends string, Schema extends z.ZodObject<any>>(
  name: Name,
  schema: Schema
): TableQueryInterpolator<{
  name: Name;
  columns: Array<Extract<keyof z.infer<Schema>, string>>;
}> {
  return getTable({ name, columns: Object.keys(schema.shape) }) as any;
}

export type BaseTableQueryInterpolator = TableQueryInterpolator<{
  name: string;
  columns: [];
}>;

export type TableSqliteTypeMap<T extends BaseTableQueryInterpolator> = {
  [K in keyof T['columns']]: string;
};

export function getCreateTableQueryFromTable<T extends BaseTableQueryInterpolator>(
  table: T,
  columnTypeMap: TableSqliteTypeMap<T>
): string {
  return `
   create table if not exists "${table.toString()}" (
      ${objectKeys(table.columns)
        .map(k => `"${String(k)}" ${String(columnTypeMap[k])}`)
        .join(',\n')}
    );
    `.trim();
}

function objectKeys<T>(obj: T): Array<keyof T> {
  return Object.keys(obj as any) as any;
}
