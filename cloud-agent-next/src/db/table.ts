/* eslint-disable @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-unsafe-return */
import type { z } from 'zod';

export type TableInput = {
  name: string;
  columns: readonly string[];
};

export type TableQueryInterpolator<T extends TableInput> = {
  // The name of the table. Prefixed with underscore to avoid
  // conflicting with a column named "name"
  _name: T['name'];
  // Holds the un-prefixed version of column names e.g. "id"
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
  [K in T['columns'][number]]: `${T['name']}.${K}`;
};

/**
 * Get a convenient object for interpolating a sql table name and columns
 * into a template string.
 * @example
 * const users = getTable('users', ['id', 'email'])
 * const query = `select ${users.email} from ${users} where ${users.id} = $1`
 * @param table Table description
 */
export function getTable<T extends TableInput>(table: T): TableQueryInterpolator<T> {
  const columns: {
    [K in T['columns'][number]]: K;
    // Need any type here because we populate this object in the loop below
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = {} as any;

  const columnsWithTable: {
    [K in T['columns'][number]]: `${T['name']}.${K}`;
    // Need any type here because we populate this object in the loop below
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } = {} as any;

  for (const key of table.columns) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (columns as any)[key] = key;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 * @example
 * const UserRecord = z.object({ id: z.string(), email: z.string() })
 * const users = getTableFromZodSchema('users', UserRecord)
 * const query = `select ${users.email} from ${users} where ${users.id} = $1`
 * @param name The name of your table
 * @param schema The Zod object schema
 */
export function getTableFromZodSchema<
  Name extends string,
  Schema extends z.ZodObject<z.ZodRawShape>,
>(
  name: Name,
  schema: Schema
): TableQueryInterpolator<{
  name: Name;
  columns: Array<Extract<keyof z.infer<Schema>, string>>;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getTable({ name, columns: Object.keys(schema.shape) }) as any;
}

export type BaseTableQueryInterpolator = TableQueryInterpolator<{
  name: string;
  columns: [];
}>;

export type TablePostgresTypeMap<T extends BaseTableQueryInterpolator> = {
  [K in keyof T['columns']]: string;
};

/**
 * Given a table and a mapping of column names to postgres types,
 * return the create table and alter table statements to safely
 * migrate this entity.
 * @param table The table description
 * @param columnTypeMap A mapping of table columns to postgres types
 */
export function getCreateTableQueryFromTable<T extends BaseTableQueryInterpolator>(
  table: T,
  columnTypeMap: TablePostgresTypeMap<T>
): string {
  const alterTableStatements = objectKeys(table.columns)
    .map(
      k => /* sql */ `alter table "${table}" add column if not exists "${k}" ${columnTypeMap[k]};`
    )
    .join('\n');

  return /* sql */ `
create table if not exists "${table}"();
${alterTableStatements}
	`.trim();
}

function objectKeys<T>(obj: T): Array<keyof T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Object.keys(obj as any) as any;
}

export function getCreateTypeFromZodEnum /* maybe one day uncomment this code <ZEnum extends ReturnType<typeof z.enum>> */(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zodEnum: any /* ZEnum */
): string {
  return /* sql */ `
DO $$
begin
	perform add_type('${name}', 'enum ()');
end$$;

-- Types need to be committed before they're used
start transaction;
${Object.keys(zodEnum.enum)
  .map(k => /* sql */ `alter type ${name} add value if not exists '${k}';`)
  .join('\n')}
commit;
  `.trim();
}

export function getCreateModifiedOnTriggerForTable<
  T extends TableQueryInterpolator<{ name: string; columns: ['modified_on'] }>,
>(table: T): string {
  return /* sql */ `
create or replace trigger update_${table}_modified_on
before update on ${table}
for each row execute procedure update_modified_on();
  `.trim();
}
