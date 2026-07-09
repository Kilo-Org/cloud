import { db, type db as defaultDb } from '@/lib/drizzle';
import { sql } from 'drizzle-orm';

export type CreditTransactionIndexScriptArgs = {
  execute: boolean;
};

type CreditTransactionIndexDb = Pick<typeof defaultDb, 'execute'>;

type CreditTransactionIndexCatalogRow = {
  schema_name: string;
  index_name: string;
  table_schema_name: string;
  table_name: string;
  is_valid: boolean;
  is_ready: boolean;
};

const creditTransactionIndexDefinitions = [
  {
    name: 'IDX_credit_transactions_user_negative_created',
    statement:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_credit_transactions_user_negative_created" ON "credit_transactions" ("kilo_user_id", "created_at") WHERE "amount_microdollars" < 0',
  },
  {
    name: 'IDX_credit_transactions_org_negative_created',
    statement:
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_credit_transactions_org_negative_created" ON "credit_transactions" ("organization_id", "created_at") WHERE "amount_microdollars" < 0 AND "organization_id" IS NOT NULL',
  },
];

function usage(): string {
  return [
    'Usage:',
    '  pnpm --filter web script:run db credit-transaction-indexes [--execute]',
    '',
    'Defaults to dry-run. --execute creates Cost Insights credit transaction indexes concurrently.',
  ].join('\n');
}

export function parseCreditTransactionIndexScriptArgs(
  args: string[]
): CreditTransactionIndexScriptArgs {
  if (args.length === 0) return { execute: false };
  if (args.length === 1 && args[0] === '--execute') return { execute: true };
  throw new Error(`Unknown arguments: ${args.join(' ')}.\n${usage()}`);
}

async function getCreditTransactionIndexState(
  fromDb: CreditTransactionIndexDb,
  indexName: string
): Promise<CreditTransactionIndexCatalogRow | null> {
  const result = await fromDb.execute<CreditTransactionIndexCatalogRow>(sql`
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

  const [indexState] = result.rows;
  return indexState ?? null;
}

function assertIndexTargetsCreditTransactions(state: CreditTransactionIndexCatalogRow): void {
  if (
    state.schema_name !== 'public' ||
    state.table_schema_name !== 'public' ||
    state.table_name !== 'credit_transactions'
  ) {
    throw new Error(
      `Index ${state.schema_name}.${state.index_name} targets ${state.table_schema_name}.${state.table_name}, expected public.credit_transactions.`
    );
  }
}

export async function provisionCreditTransactionIndexes(
  fromDb: CreditTransactionIndexDb,
  options: CreditTransactionIndexScriptArgs
): Promise<void> {
  console.log(
    JSON.stringify({
      mode: options.execute ? 'execute' : 'dry-run',
      indexes: creditTransactionIndexDefinitions.map(index => index.name),
    })
  );

  for (const index of creditTransactionIndexDefinitions) {
    const initialState = await getCreditTransactionIndexState(fromDb, index.name);
    if (initialState) assertIndexTargetsCreditTransactions(initialState);

    const needsRebuild =
      initialState !== null && (!initialState.is_valid || !initialState.is_ready);
    const needsCreate = initialState === null || needsRebuild;
    console.log(
      JSON.stringify({
        mode: options.execute ? 'execute-index' : 'dry-run-index',
        indexName: index.name,
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

    const finalState = await getCreditTransactionIndexState(fromDb, index.name);
    if (!finalState)
      throw new Error(`Index public.${index.name} was not found after provisioning.`);
    assertIndexTargetsCreditTransactions(finalState);
    if (!finalState.is_valid || !finalState.is_ready) {
      throw new Error(
        `Index public.${index.name} is not valid and ready after provisioning (indisvalid=${finalState.is_valid}, indisready=${finalState.is_ready}).`
      );
    }
  }
}

export async function run(...args: string[]): Promise<void> {
  await provisionCreditTransactionIndexes(db, parseCreditTransactionIndexScriptArgs(args));
}
