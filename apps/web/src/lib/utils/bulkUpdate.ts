import { sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { chunkArray } from './chunkArray';

type DbExecutor = {
  execute: (query: ReturnType<typeof sql>) => Promise<{ rowCount: number | null }>;
};

type BulkUpdateOptions<
  TTable extends PgTable,
  TIdCol extends PgColumn,
  TValueCol extends PgColumn,
> = {
  tx: DbExecutor;
  table: TTable;
  idColumn: TIdCol;
  valueColumn: TValueCol;
  updates: { id: TIdCol['_']['data']; value: TValueCol['_']['data'] }[];
  chunkSize?: number;
};

export async function bulkUpdate<
  TTable extends PgTable,
  TIdCol extends PgColumn,
  TValueCol extends PgColumn,
>(args: BulkUpdateOptions<TTable, TIdCol, TValueCol>): Promise<number> {
  if (args.updates.length === 0) return 0;

  const idType = args.idColumn.getSQLType();
  const valueType = args.valueColumn.getSQLType();
  let totalRowCount = 0;

  for (const chunk of chunkArray(args.updates, args.chunkSize ?? 3000)) {
    const valueColumnName = sql.identifier(args.valueColumn.name);
    const updateResult = await args.tx.execute(sql`
      UPDATE ${args.table}
      SET ${valueColumnName} = v.new_value
      FROM (VALUES ${sql.join(
        chunk.map(
          ({ id, value }) => sql`(${id}::${sql.raw(idType)}, ${value}::${sql.raw(valueType)})`
        ),
        sql`, `
      )}) AS v(id, new_value)
      WHERE ${args.idColumn} = v.id
    `);
    totalRowCount += updateResult?.rowCount ?? 0;
  }

  return totalRowCount;
}
