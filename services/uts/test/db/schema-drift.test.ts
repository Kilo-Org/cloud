import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { IDENTITY_STORE_ENUMS } from '../../src/db/enums';
import { IDENTITY_STORE_TABLES } from '../../src/db/rows';
import { TestDatabase, auditEvent } from './harness';

let db: TestDatabase;
let owner: pg.Client;

beforeAll(async () => {
  db = await TestDatabase.create();
  owner = await db.connectAsOwner();
});
afterAll(() => db.drop());

type Column = {
  column_name: string;
  nullable: boolean;
  /** The type the server reports for the column: a domain's base type, otherwise the type. */
  wire_type: string;
  is_enum: boolean;
  is_array: boolean;
};

/** Columns whose row schema is narrower than their SQL type, with a value the schema accepts. */
const SAMPLE_OVERRIDES: Record<string, unknown> = {
  'audit_events.event': auditEvent(),
};

const SCALAR_SAMPLES: Record<string, string> = {
  smallint: `'1'::smallint`,
  integer: `'1'::integer`,
  bigint: `'1'::bigint`,
  xid8: `'1'::xid8`,
  boolean: 'true',
  'timestamp with time zone': 'now()',
  bytea: `decode(repeat('00', 32), 'hex')`,
  uuid: 'gen_random_uuid()',
  jsonb: `'{}'::jsonb`,
  inet: `'192.0.2.1'::inet`,
  text: `'x'::text`,
};

/**
 * A SQL expression of the column's wire type, so `pg` decodes it exactly as it decodes the
 * column. Arrays are empty: a built-in array type decodes to an array, while an enum array or an
 * array of a domain arrives as an array literal string.
 */
function sampleExpression(column: Column): string {
  if (column.is_array) return `'{}'::${column.wire_type}`;
  if (column.is_enum) return `enum_first(NULL::${column.wire_type})`;
  const sample = SCALAR_SAMPLES[column.wire_type];
  if (sample === undefined) throw new Error(`no sample for type ${column.wire_type}`);
  return sample;
}

describe('src/db matches the migrated schema', () => {
  it('lists every enum with its values in database order', async () => {
    const result = await owner.query<{ name: string; values: string[] }>(
      `SELECT type.typname::text AS name,
              array_agg(enum.enumlabel::text ORDER BY enum.enumsortorder) AS values
       FROM pg_type AS type
       JOIN pg_enum AS enum ON enum.enumtypid = type.oid
       WHERE type.typnamespace = 'uts'::regnamespace
       GROUP BY type.typname
       ORDER BY type.typname`
    );
    const expected = Object.entries(IDENTITY_STORE_ENUMS)
      .map(([name, values]) => ({ name, values: [...values] }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(result.rows).toEqual(expected);
  });

  it.each(Object.entries(IDENTITY_STORE_TABLES))(
    'has a row schema for uts.%s with the same columns, types and nullability',
    async (table, schema) => {
      const columns = await owner.query<Column>(
        `SELECT attribute.attname::text AS column_name,
                NOT attribute.attnotnull AS nullable,
                format_type(wire.oid, NULL) AS wire_type,
                wire.typtype = 'e' AS is_enum,
                wire.typcategory = 'A' AS is_array
         FROM pg_attribute AS attribute
         JOIN pg_type AS declared ON declared.oid = attribute.atttypid
         JOIN pg_type AS wire
           ON wire.oid = CASE declared.typtype WHEN 'd' THEN declared.typbasetype ELSE declared.oid END
         WHERE attribute.attrelid = to_regclass('uts.' || $1)
           AND attribute.attnum > 0 AND NOT attribute.attisdropped
         ORDER BY attribute.attnum`,
        [table]
      );
      expect(columns.rows.map(column => column.column_name)).toEqual(Object.keys(schema.shape));

      const values: unknown[] = [];
      const expressions = columns.rows.map(column => {
        const override = SAMPLE_OVERRIDES[`${table}.${column.column_name}`];
        if (override === undefined) return `${sampleExpression(column)} AS ${column.column_name}`;
        values.push(override);
        return `$${values.length}::${column.wire_type} AS ${column.column_name}`;
      });
      const sample = await owner.query(`SELECT ${expressions.join(', ')}`, values);
      expect(schema.safeParse(sample.rows[0]).error).toBeUndefined();

      const fields = new Map<string, z.ZodType>(Object.entries(schema.shape));
      for (const column of columns.rows) {
        expect({
          column: column.column_name,
          nullable: fields.get(column.column_name)?.safeParse(null).success,
        }).toEqual({ column: column.column_name, nullable: column.nullable });
      }
    }
  );
});
