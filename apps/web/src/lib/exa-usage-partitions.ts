import type { db as defaultDb } from '@/lib/drizzle';
import { sql } from 'drizzle-orm';
import { format } from 'date-fns';

type ExaPartitionDb = Pick<typeof defaultDb, 'execute'>;

export type ExaUsageLogPartitionProvisioningResult = {
  created: string[];
  errors: Array<{ name: string; error: unknown }>;
};

export type ExaUsageLogPartitionIndexDefinition = {
  name: string;
  statement: string;
};

const POSTGRES_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;
const EXA_USAGE_LOG_PARTITION_PATTERN = /^exa_usage_log_\d{4}_(?:0[1-9]|1[0-2])$/;
const EXA_USAGE_LOG_PARTITION_INDEX_PATTERN =
  /^exa_usage_log_\d{4}_(?:0[1-9]|1[0-2])_charged_(?:org_)?created_at_idx$/;
const POSTGRES_IDENTIFIER_MAX_LENGTH = 63;

function quoteIdentifier(identifier: string): string {
  if (
    identifier.length > POSTGRES_IDENTIFIER_MAX_LENGTH ||
    !POSTGRES_IDENTIFIER_PATTERN.test(identifier)
  ) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function buildExaUsageLogPartitionIndexDropStatement(
  schemaName: string,
  indexName: string
): string {
  if (!EXA_USAGE_LOG_PARTITION_INDEX_PATTERN.test(indexName)) {
    throw new Error(`Invalid Exa usage-log partition index name: ${indexName}`);
  }

  return `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdentifier(schemaName)}.${quoteIdentifier(indexName)}`;
}

export function buildExaUsageLogPartitionIndexDefinitions(
  schemaName: string,
  partitionName: string,
  concurrently: boolean
): ExaUsageLogPartitionIndexDefinition[] {
  if (!EXA_USAGE_LOG_PARTITION_PATTERN.test(partitionName)) {
    throw new Error(`Invalid Exa usage-log partition name: ${partitionName}`);
  }

  const tableName = `${quoteIdentifier(schemaName)}.${quoteIdentifier(partitionName)}`;
  const concurrentlyClause = concurrently ? ' CONCURRENTLY' : '';
  const definitions = [
    {
      name: `${partitionName}_charged_created_at_idx`,
      columns: '"created_at"',
      predicate: '"charged_to_balance" = true AND "cost_microdollars" > 0',
    },
    {
      name: `${partitionName}_charged_org_created_at_idx`,
      columns: '"organization_id", "created_at"',
      predicate:
        '"organization_id" IS NOT NULL AND "charged_to_balance" = true AND "cost_microdollars" > 0',
    },
  ];

  return definitions.map(definition => ({
    name: definition.name,
    statement: `CREATE INDEX${concurrentlyClause} IF NOT EXISTS ${quoteIdentifier(definition.name)} ON ${tableName} (${definition.columns}) WHERE ${definition.predicate}`,
  }));
}

/**
 * Creates the current month and next two monthly audit-log partitions.
 *
 * The cron endpoint reports all failed partitions, while test setup treats any
 * failed partition as fatal after calling this best-effort helper.
 */
export async function provisionExaUsageLogPartitions(
  fromDb: ExaPartitionDb,
  now: Date = new Date()
): Promise<ExaUsageLogPartitionProvisioningResult> {
  const created: string[] = [];
  const errors: Array<{ name: string; error: unknown }> = [];

  for (let offset = 0; offset <= 2; offset++) {
    const target = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const nextMonth = new Date(target.getFullYear(), target.getMonth() + 1, 1);
    const name = `exa_usage_log_${format(target, 'yyyy_MM')}`;

    try {
      await fromDb.execute(
        sql.raw(
          `CREATE TABLE IF NOT EXISTS "public"."${name}" PARTITION OF "public"."exa_usage_log" FOR VALUES FROM ('${format(target, 'yyyy-MM-dd')}') TO ('${format(nextMonth, 'yyyy-MM-dd')}')`
        )
      );

      // Existing and current partitions require the concurrent operator path. Future
      // partitions are write-free, so regular local index creation is deploy-safe.
      if (offset > 0) {
        const indexDefinitions = buildExaUsageLogPartitionIndexDefinitions('public', name, false);
        for (const definition of indexDefinitions) {
          await fromDb.execute(sql.raw(definition.statement));
        }
      }

      created.push(name);
    } catch (error) {
      errors.push({ name, error });
    }
  }

  return { created, errors };
}
