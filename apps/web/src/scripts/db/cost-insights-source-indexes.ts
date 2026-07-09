import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

export type CostInsightsSourceIndexScriptArgs = {
  execute: boolean;
};

type CostInsightsSourceIndexDb = {
  execute(query: SQL): PromiseLike<{ rows: Record<string, unknown>[] }>;
};

type CostInsightsSourceIndexCatalogRow = {
  schema_name: string;
  index_name: string;
  table_schema_name: string;
  table_name: string;
  is_valid: boolean;
  is_ready: boolean;
};

const costInsightsSourceIndexDefinitions = [
  {
    name: 'IDX_coding_plan_terms_credit_transaction',
    tableName: 'coding_plan_terms',
    statement:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_coding_plan_terms_credit_transaction" ON "coding_plan_terms" ("credit_transaction_id")',
  },
  {
    name: 'idx_microdollar_usage_org_created_at',
    tableName: 'microdollar_usage',
    statement:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_microdollar_usage_org_created_at" ON "microdollar_usage" ("organization_id", "created_at") WHERE "organization_id" IS NOT NULL',
  },
] as const;

function usage(): string {
  return [
    'Usage:',
    '  pnpm --filter web script:run db cost-insights-source-indexes [--execute]',
    '',
    'Defaults to dry-run. --execute creates Cost Insights source fallback indexes concurrently.',
  ].join('\n');
}

export function parseCostInsightsSourceIndexScriptArgs(
  args: string[]
): CostInsightsSourceIndexScriptArgs {
  if (args.length === 0) return { execute: false };
  if (args.length === 1 && args[0] === '--execute') return { execute: true };
  throw new Error(`Unknown arguments: ${args.join(' ')}.\n${usage()}`);
}

async function getCostInsightsSourceIndexState(
  fromDb: CostInsightsSourceIndexDb,
  indexName: string
): Promise<CostInsightsSourceIndexCatalogRow | null> {
  const result = await fromDb.execute(sql`
    SELECT
      index_namespace.nspname AS schema_name,
      index_class.relname AS index_name,
      table_namespace.nspname AS table_schema_name,
      table_class.relname AS table_name,
      index_catalog.indisvalid AS is_valid,
      index_catalog.indisready AS is_ready
    FROM pg_catalog.pg_index AS index_catalog
    INNER JOIN pg_catalog.pg_class AS index_class
      ON index_class.oid = index_catalog.indexrelid
    INNER JOIN pg_catalog.pg_namespace AS index_namespace
      ON index_namespace.oid = index_class.relnamespace
    INNER JOIN pg_catalog.pg_class AS table_class
      ON table_class.oid = index_catalog.indrelid
    INNER JOIN pg_catalog.pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    WHERE index_namespace.nspname = 'public'
      AND index_class.relname = ${indexName}
  `);

  const [indexState] = result.rows as CostInsightsSourceIndexCatalogRow[];
  return indexState ?? null;
}

function assertIndexTargetsTable(
  state: CostInsightsSourceIndexCatalogRow,
  tableName: string
): void {
  if (
    state.schema_name !== 'public' ||
    state.table_schema_name !== 'public' ||
    state.table_name !== tableName
  ) {
    throw new Error(
      `Index ${state.schema_name}.${state.index_name} targets ${state.table_schema_name}.${state.table_name}, expected public.${tableName}.`
    );
  }
}

export async function provisionCostInsightsSourceIndexes(
  fromDb: CostInsightsSourceIndexDb,
  options: CostInsightsSourceIndexScriptArgs
): Promise<void> {
  console.log(
    JSON.stringify({
      mode: options.execute ? 'execute' : 'dry-run',
      indexes: costInsightsSourceIndexDefinitions.map(index => index.name),
    })
  );

  for (const index of costInsightsSourceIndexDefinitions) {
    const initialState = await getCostInsightsSourceIndexState(fromDb, index.name);
    if (initialState) assertIndexTargetsTable(initialState, index.tableName);

    const needsRebuild =
      initialState !== null && (!initialState.is_valid || !initialState.is_ready);
    const needsCreate = initialState === null || needsRebuild;
    console.log(
      JSON.stringify({
        mode: options.execute ? 'execute-index' : 'dry-run-index',
        indexName: index.name,
        tableName: index.tableName,
        initialState: initialState
          ? { valid: initialState.is_valid, ready: initialState.is_ready }
          : null,
        action: needsRebuild ? 'rebuild' : needsCreate ? 'create' : 'verify',
      })
    );

    if (!options.execute) continue;

    if (needsRebuild) {
      await fromDb.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS "public"."${index.name}"`));
    }
    if (needsCreate) {
      await fromDb.execute(sql.raw(index.statement));
    }

    const finalState = await getCostInsightsSourceIndexState(fromDb, index.name);
    if (!finalState)
      throw new Error(`Index public.${index.name} was not found after provisioning.`);
    assertIndexTargetsTable(finalState, index.tableName);
    if (!finalState.is_valid || !finalState.is_ready) {
      throw new Error(
        `Index public.${index.name} is not valid and ready after provisioning (indisvalid=${finalState.is_valid}, indisready=${finalState.is_ready}).`
      );
    }
  }
}

export async function run(...args: string[]): Promise<void> {
  const { db } = await import('../../lib/drizzle');
  await provisionCostInsightsSourceIndexes(db, parseCostInsightsSourceIndexScriptArgs(args));
}
