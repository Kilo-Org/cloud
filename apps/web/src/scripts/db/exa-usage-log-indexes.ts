import { setTimeout as sleep } from 'node:timers/promises';

import { db, type db as defaultDb } from '@/lib/drizzle';
import {
  buildExaUsageLogPartitionIndexDefinitions,
  buildExaUsageLogPartitionIndexDropStatement,
} from '@/lib/exa-usage-partitions';
import { sql } from 'drizzle-orm';

export type ExaUsageLogIndexScriptArgs = {
  execute: boolean;
  maxPartitions?: number;
  sleepMs: number;
};

type ExaUsageLogIndexDb = Pick<typeof defaultDb, 'execute'>;

type ExaUsageLogPartitionCatalogRow = {
  schema_name: string;
  partition_name: string;
};

type ExaUsageLogIndexCatalogRow = {
  schema_name: string;
  index_name: string;
  partition_schema_name: string;
  partition_name: string;
  is_valid: boolean;
  is_ready: boolean;
};

function usage(): string {
  return [
    'Usage:',
    '  pnpm --filter web script:run db exa-usage-log-indexes [--max-partitions <count>] [--sleep-ms <ms>] [--execute]',
    '',
    'Defaults to dry-run. --execute creates both local partial indexes on each selected partition.',
    'Partitions are read newest-first from PostgreSQL catalogs. --max-partitions bounds one run; --sleep-ms paces partitions.',
  ].join('\n');
}

function parseInteger(value: string | undefined, flag: string, allowZero: boolean): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error(
      `${flag} must be ${allowZero ? 'a non-negative' : 'a positive'} integer.\n${usage()}`
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed === 0)) {
    throw new Error(
      `${flag} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer.\n${usage()}`
    );
  }
  return parsed;
}

export function parseExaUsageLogIndexScriptArgs(args: string[]): ExaUsageLogIndexScriptArgs {
  let execute = false;
  let maxPartitions: number | undefined;
  let sleepMs = 0;
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) {
      throw new Error(`Duplicate flag: ${flag}.\n${usage()}`);
    }
    seen.add(flag);

    if (flag === '--execute') {
      execute = true;
      continue;
    }
    if (flag !== '--max-partitions' && flag !== '--sleep-ms') {
      throw new Error(`Unknown flag: ${flag}.\n${usage()}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}.\n${usage()}`);
    }
    index++;

    if (flag === '--max-partitions') {
      maxPartitions = parseInteger(value, flag, false);
    } else {
      sleepMs = parseInteger(value, flag, true);
    }
  }

  return {
    execute,
    ...(maxPartitions === undefined ? {} : { maxPartitions }),
    sleepMs,
  };
}

export async function listExaUsageLogPartitions(
  fromDb: ExaUsageLogIndexDb
): Promise<ExaUsageLogPartitionCatalogRow[]> {
  const result = await fromDb.execute<ExaUsageLogPartitionCatalogRow>(sql`
    SELECT
      partition_namespace.nspname AS schema_name,
      partition_class.relname AS partition_name
    FROM pg_catalog.pg_partition_tree(
      pg_catalog.to_regclass('public.exa_usage_log')
    ) AS partition_tree
    INNER JOIN pg_catalog.pg_class AS partition_class
      ON partition_class.oid = partition_tree.relid
    INNER JOIN pg_catalog.pg_namespace AS partition_namespace
      ON partition_namespace.oid = partition_class.relnamespace
    WHERE partition_tree.level > 0
      AND partition_tree.isleaf
      AND partition_class.relispartition
    ORDER BY partition_class.relname DESC
  `);

  return result.rows;
}

async function getExaUsageLogIndexState(
  fromDb: ExaUsageLogIndexDb,
  schemaName: string,
  indexName: string
): Promise<ExaUsageLogIndexCatalogRow | null> {
  const result = await fromDb.execute<ExaUsageLogIndexCatalogRow>(sql`
    SELECT
      index_namespace.nspname AS schema_name,
      index_class.relname AS index_name,
      partition_namespace.nspname AS partition_schema_name,
      partition_class.relname AS partition_name,
      index_catalog.indisvalid AS is_valid,
      index_catalog.indisready AS is_ready
    FROM pg_catalog.pg_index AS index_catalog
    INNER JOIN pg_catalog.pg_class AS index_class
      ON index_class.oid = index_catalog.indexrelid
    INNER JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_class.relnamespace
    INNER JOIN pg_catalog.pg_class AS partition_class
      ON partition_class.oid = index_catalog.indrelid
    INNER JOIN pg_catalog.pg_namespace AS partition_namespace
      ON partition_namespace.oid = partition_class.relnamespace
    WHERE index_namespace.nspname = ${schemaName}
      AND index_class.relname = ${indexName}
  `);

  const [indexState] = result.rows;
  return indexState ?? null;
}

function assertIndexTargetsPartition(
  state: ExaUsageLogIndexCatalogRow,
  schemaName: string,
  partitionName: string
): void {
  if (
    state.partition_schema_name !== schemaName ||
    state.partition_name !== partitionName ||
    state.schema_name !== schemaName
  ) {
    throw new Error(
      `Index ${state.schema_name}.${state.index_name} targets ${state.partition_schema_name}.${state.partition_name}, expected ${schemaName}.${partitionName}.`
    );
  }
}

export async function provisionHistoricalExaUsageLogIndexes(
  fromDb: ExaUsageLogIndexDb,
  options: ExaUsageLogIndexScriptArgs
): Promise<void> {
  const partitions = await listExaUsageLogPartitions(fromDb);
  const selectedPartitions =
    options.maxPartitions === undefined ? partitions : partitions.slice(0, options.maxPartitions);
  const plans = selectedPartitions.map(partition => ({
    ...partition,
    indexes: buildExaUsageLogPartitionIndexDefinitions(
      partition.schema_name,
      partition.partition_name,
      true
    ),
  }));

  console.log(
    JSON.stringify({
      mode: options.execute ? 'execute' : 'dry-run',
      discoveredPartitionCount: partitions.length,
      selectedPartitionCount: plans.length,
      maxPartitions: options.maxPartitions ?? null,
      sleepMs: options.sleepMs,
    })
  );

  for (let partitionIndex = 0; partitionIndex < plans.length; partitionIndex++) {
    const plan = plans[partitionIndex];
    if (!options.execute) {
      console.log(
        JSON.stringify({
          mode: 'dry-run-partition',
          schemaName: plan.schema_name,
          partitionName: plan.partition_name,
          indexes: plan.indexes,
        })
      );
      continue;
    }

    for (const index of plan.indexes) {
      const initialState = await getExaUsageLogIndexState(fromDb, plan.schema_name, index.name);
      if (initialState) {
        assertIndexTargetsPartition(initialState, plan.schema_name, plan.partition_name);
      }

      const needsRebuild =
        initialState !== null && (!initialState.is_valid || !initialState.is_ready);
      const needsCreate = initialState === null || needsRebuild;
      console.log(
        JSON.stringify({
          mode: 'execute-index',
          schemaName: plan.schema_name,
          partitionName: plan.partition_name,
          indexName: index.name,
          initialState: initialState
            ? { valid: initialState.is_valid, ready: initialState.is_ready }
            : null,
          action: needsRebuild ? 'rebuild' : needsCreate ? 'create' : 'verify',
        })
      );

      if (needsRebuild) {
        await fromDb.execute(
          sql.raw(buildExaUsageLogPartitionIndexDropStatement(plan.schema_name, index.name))
        );
      }
      if (needsCreate) {
        await fromDb.execute(sql.raw(index.statement));
      }

      const finalState = await getExaUsageLogIndexState(fromDb, plan.schema_name, index.name);
      if (!finalState) {
        throw new Error(
          `Index ${plan.schema_name}.${index.name} was not found after provisioning.`
        );
      }
      assertIndexTargetsPartition(finalState, plan.schema_name, plan.partition_name);
      if (!finalState.is_valid || !finalState.is_ready) {
        throw new Error(
          `Index ${plan.schema_name}.${index.name} is not valid and ready after provisioning (indisvalid=${finalState.is_valid}, indisready=${finalState.is_ready}).`
        );
      }
    }

    if (options.sleepMs > 0 && partitionIndex < plans.length - 1) {
      await sleep(options.sleepMs);
    }
  }
}

export async function run(...args: string[]): Promise<void> {
  await provisionHistoricalExaUsageLogIndexes(db, parseExaUsageLogIndexScriptArgs(args));
}
