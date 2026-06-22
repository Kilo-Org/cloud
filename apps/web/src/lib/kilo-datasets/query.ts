import 'server-only';
import { sql, type SQL } from 'drizzle-orm';
import {
  cliSessions,
  cli_sessions_v2,
  cloud_agent_code_reviews,
  microdollar_usage,
  type User,
} from '@kilocode/db/schema';
import { readDb } from '@/lib/drizzle';
import { timedUsageQuery } from '@/lib/usage-query';
import {
  QueryKiloDatasetInputSchema,
  type QueryKiloDatasetColumn,
  type QueryKiloDatasetInput,
  type QueryKiloDatasetOutput,
} from './contracts';

const maxRangeMs = 60 * 24 * 60 * 60 * 1000;

type ColumnType = QueryKiloDatasetColumn['type'];
type DatasetName = QueryKiloDatasetInput['dataset'];
type Field = {
  expression: SQL;
  type: ColumnType;
  nullable: boolean;
  group?: boolean;
  metric?: boolean;
  searchable?: boolean;
};
type Catalog = {
  from: SQL;
  fields: Record<string, Field>;
  mandatoryWhere: SQL[];
  countOnly?: boolean;
};
type NormalizedRange = { startDate: string; endDate: string };
type Scalar = string | number | boolean;

class DatasetQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatasetQueryError';
  }
}

function parseDate(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DatasetQueryError(`${field} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeRange(input: QueryKiloDatasetInput['range'], now: Date): NormalizedRange {
  const end = input?.endDate ? parseDate(input.endDate, 'endDate') : now;
  const start = input?.startDate
    ? parseDate(input.startDate, 'startDate')
    : new Date(end.getTime() - maxRangeMs);
  if (start.getTime() >= end.getTime()) {
    throw new DatasetQueryError('startDate must be before endDate');
  }
  if (end.getTime() - start.getTime() > maxRangeMs) {
    throw new DatasetQueryError('range cannot exceed 60 days');
  }
  return { startDate: start.toISOString(), endDate: end.toISOString() };
}

function microdollarUsageCatalog(user: User, range: NormalizedRange): Catalog {
  const costUsd = sql`(${microdollar_usage.cost}::numeric / 1000000)`;
  return {
    from: sql`${microdollar_usage}`,
    mandatoryWhere: [
      sql`${microdollar_usage.kilo_user_id} = ${user.id}`,
      sql`${microdollar_usage.created_at} >= ${range.startDate}`,
      sql`${microdollar_usage.created_at} < ${range.endDate}`,
    ],
    fields: {
      organizationId: {
        expression: sql`${microdollar_usage.organization_id}`,
        type: 'string',
        nullable: true,
        group: true,
      },
      createdAt: {
        expression: sql`${microdollar_usage.created_at}`,
        type: 'timestamp',
        nullable: false,
      },
      costMicrodollars: {
        expression: sql`${microdollar_usage.cost}`,
        type: 'integer',
        nullable: false,
        metric: true,
      },
      costUsd: { expression: costUsd, type: 'decimal', nullable: false, metric: true },
      inputTokens: {
        expression: sql`${microdollar_usage.input_tokens}`,
        type: 'integer',
        nullable: false,
        metric: true,
      },
      outputTokens: {
        expression: sql`${microdollar_usage.output_tokens}`,
        type: 'integer',
        nullable: false,
        metric: true,
      },
      cacheWriteTokens: {
        expression: sql`${microdollar_usage.cache_write_tokens}`,
        type: 'integer',
        nullable: false,
        metric: true,
      },
      cacheHitTokens: {
        expression: sql`${microdollar_usage.cache_hit_tokens}`,
        type: 'integer',
        nullable: false,
        metric: true,
      },
      provider: {
        expression: sql`${microdollar_usage.provider}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
      model: {
        expression: sql`COALESCE(${microdollar_usage.requested_model}, ${microdollar_usage.model})`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
      hasError: {
        expression: sql`${microdollar_usage.has_error}`,
        type: 'boolean',
        nullable: false,
        group: true,
      },
      inferenceProvider: {
        expression: sql`${microdollar_usage.inference_provider}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
      projectId: {
        expression: sql`${microdollar_usage.project_id}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
    },
  };
}

function codeReviewsCatalog(user: User, range: NormalizedRange): Catalog {
  const totalCostUsd = sql`(${cloud_agent_code_reviews.total_cost_musd}::numeric / 1000000)`;
  return {
    from: sql`${cloud_agent_code_reviews}`,
    mandatoryWhere: [
      sql`${cloud_agent_code_reviews.owned_by_user_id} = ${user.id}`,
      sql`${cloud_agent_code_reviews.created_at} >= ${range.startDate}`,
      sql`${cloud_agent_code_reviews.created_at} < ${range.endDate}`,
    ],
    fields: {
      createdAt: {
        expression: sql`${cloud_agent_code_reviews.created_at}`,
        type: 'timestamp',
        nullable: false,
      },
      startedAt: {
        expression: sql`${cloud_agent_code_reviews.started_at}`,
        type: 'timestamp',
        nullable: true,
      },
      completedAt: {
        expression: sql`${cloud_agent_code_reviews.completed_at}`,
        type: 'timestamp',
        nullable: true,
      },
      platform: {
        expression: sql`${cloud_agent_code_reviews.platform}`,
        type: 'string',
        nullable: false,
        group: true,
        searchable: true,
      },
      repository: {
        expression: sql`${cloud_agent_code_reviews.repo_full_name}`,
        type: 'string',
        nullable: false,
        group: true,
        searchable: true,
      },
      status: {
        expression: sql`${cloud_agent_code_reviews.status}`,
        type: 'string',
        nullable: false,
        group: true,
        searchable: true,
      },
      terminalReason: {
        expression: sql`${cloud_agent_code_reviews.terminal_reason}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
      agentVersion: {
        expression: sql`${cloud_agent_code_reviews.agent_version}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
      repositoryReviewInstructionsUsed: {
        expression: sql`${cloud_agent_code_reviews.repository_review_instructions_used}`,
        type: 'boolean',
        nullable: false,
        group: true,
      },
      model: {
        expression: sql`${cloud_agent_code_reviews.model}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
      totalInputTokens: {
        expression: sql`${cloud_agent_code_reviews.total_tokens_in}`,
        type: 'integer',
        nullable: true,
        metric: true,
      },
      totalOutputTokens: {
        expression: sql`${cloud_agent_code_reviews.total_tokens_out}`,
        type: 'integer',
        nullable: true,
        metric: true,
      },
      totalCostMicrodollars: {
        expression: sql`${cloud_agent_code_reviews.total_cost_musd}`,
        type: 'integer',
        nullable: true,
        metric: true,
      },
      totalCostUsd: { expression: totalCostUsd, type: 'decimal', nullable: true, metric: true },
    },
  };
}

function sessionPlatformWhere(dataset: DatasetName, platformExpression: SQL): SQL {
  if (dataset === 'cloud_sessions') {
    return sql`${platformExpression} IN ('cloud-agent', 'cloud-agent-web')`;
  }
  if (dataset === 'cli_sessions') {
    return sql`${platformExpression} = 'cli'`;
  }
  return sql`${platformExpression} = 'vscode'`;
}

function sessionCatalog(dataset: DatasetName, user: User, range: NormalizedRange): Catalog {
  return {
    from: sql`
      (
        SELECT
          ${cliSessions.organization_id} AS organization_id,
          ${cliSessions.created_at} AS created_at,
          ${cliSessions.updated_at} AS updated_at,
          ${cliSessions.created_on_platform} AS platform,
          'v1'::text AS source_version,
          ${cliSessions.git_url} AS git_url,
          NULL::text AS git_branch,
          (${cliSessions.parent_session_id} IS NULL AND ${cliSessions.forked_from} IS NULL) AS is_root,
          NULL::text AS status,
          ${cliSessions.version} AS version,
          ${cliSessions.last_mode} AS last_mode,
          ${cliSessions.last_model} AS last_model
        FROM ${cliSessions}
        WHERE ${cliSessions.kilo_user_id} = ${user.id}
          AND ${cliSessions.created_at} >= ${range.startDate}
          AND ${cliSessions.created_at} < ${range.endDate}
          AND ${sessionPlatformWhere(dataset, sql`${cliSessions.created_on_platform}`)}
        UNION ALL
        SELECT
          ${cli_sessions_v2.organization_id} AS organization_id,
          ${cli_sessions_v2.created_at} AS created_at,
          ${cli_sessions_v2.updated_at} AS updated_at,
          ${cli_sessions_v2.created_on_platform} AS platform,
          'v2'::text AS source_version,
          ${cli_sessions_v2.git_url} AS git_url,
          ${cli_sessions_v2.git_branch} AS git_branch,
          (${cli_sessions_v2.parent_session_id} IS NULL) AS is_root,
          ${cli_sessions_v2.status} AS status,
          ${cli_sessions_v2.version} AS version,
          NULL::text AS last_mode,
          NULL::text AS last_model
        FROM ${cli_sessions_v2}
        WHERE ${cli_sessions_v2.kilo_user_id} = ${user.id}
          AND ${cli_sessions_v2.created_at} >= ${range.startDate}
          AND ${cli_sessions_v2.created_at} < ${range.endDate}
          AND ${sessionPlatformWhere(dataset, sql`${cli_sessions_v2.created_on_platform}`)}
      ) normalized_sessions
    `,
    mandatoryWhere: [],
    countOnly: true,
    fields: {
      organizationId: {
        expression: sql`${sql.identifier('organization_id')}`,
        type: 'string',
        nullable: true,
        group: true,
      },
      createdAt: {
        expression: sql`${sql.identifier('created_at')}`,
        type: 'timestamp',
        nullable: false,
      },
      updatedAt: {
        expression: sql`${sql.identifier('updated_at')}`,
        type: 'timestamp',
        nullable: false,
      },
      platform: {
        expression: sql`${sql.identifier('platform')}`,
        type: 'string',
        nullable: false,
        group: true,
        searchable: true,
      },
      sourceVersion: {
        expression: sql`${sql.identifier('source_version')}`,
        type: 'string',
        nullable: false,
        group: true,
      },
      gitUrl: {
        expression: sql`${sql.identifier('git_url')}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
      gitBranch: {
        expression: sql`${sql.identifier('git_branch')}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
      isRoot: {
        expression: sql`${sql.identifier('is_root')}`,
        type: 'boolean',
        nullable: false,
        group: true,
      },
      status: {
        expression: sql`${sql.identifier('status')}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
      version: {
        expression: sql`${sql.identifier('version')}`,
        type: 'integer',
        nullable: false,
        group: true,
      },
      lastMode: {
        expression: sql`${sql.identifier('last_mode')}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
      lastModel: {
        expression: sql`${sql.identifier('last_model')}`,
        type: 'string',
        nullable: true,
        group: true,
        searchable: true,
      },
    },
  };
}

function resolveCatalog(dataset: DatasetName, user: User, range: NormalizedRange): Catalog {
  if (dataset === 'microdollar_usage') return microdollarUsageCatalog(user, range);
  if (dataset === 'code_reviews') return codeReviewsCatalog(user, range);
  return sessionCatalog(dataset, user, range);
}

function metricAlias(metric: QueryKiloDatasetInput['metrics'][number]): string {
  return metric.operation === 'count' ? 'count' : `${metric.operation}_${metric.field}`;
}

function metricOutputType(operation: string, field: Field | undefined): ColumnType {
  if (operation === 'count' || operation === 'countDistinct') return 'integer';
  if (operation === 'avg') return 'decimal';
  if (!field) return 'integer';
  if (operation === 'sum') return field.type === 'decimal' ? 'decimal' : 'integer';
  return field.type;
}

function metricExpression(metric: QueryKiloDatasetInput['metrics'][number], catalog: Catalog): SQL {
  if (metric.operation === 'count') {
    if (metric.field) throw new DatasetQueryError('count must not specify a field');
    return sql`COUNT(*)::bigint`;
  }
  if (!metric.field) {
    throw new DatasetQueryError(`${metric.operation} requires a field`);
  }
  if (catalog.countOnly) {
    throw new DatasetQueryError('session datasets support count only in this MVP');
  }
  const field = catalog.fields[metric.field];
  if (!field?.metric) {
    throw new DatasetQueryError(`metric field is not allowed: ${metric.field}`);
  }
  if (metric.operation === 'countDistinct') return sql`COUNT(DISTINCT ${field.expression})::bigint`;
  if (metric.operation === 'sum') return sql`COALESCE(SUM(${field.expression}), 0)`;
  if (metric.operation === 'avg') return sql`AVG(${field.expression})`;
  if (metric.operation === 'min') return sql`MIN(${field.expression})`;
  return sql`MAX(${field.expression})`;
}

function requireScalar(value: unknown, label: string): Scalar {
  if (typeof value === 'string') {
    if (value.length > 200) throw new DatasetQueryError(`${label} is too long`);
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  throw new DatasetQueryError(`${label} must be a scalar value`);
}

function compileFilter(
  filter: NonNullable<QueryKiloDatasetInput['filters']>[number],
  catalog: Catalog
): SQL {
  const field = catalog.fields[filter.field];
  if (!field) throw new DatasetQueryError(`unknown filter field: ${filter.field}`);
  if (filter.operator === 'isNull') {
    if (filter.value !== undefined) throw new DatasetQueryError('isNull must not specify a value');
    return sql`${field.expression} IS NULL`;
  }
  if (filter.operator === 'isNotNull') {
    if (filter.value !== undefined)
      throw new DatasetQueryError('isNotNull must not specify a value');
    return sql`${field.expression} IS NOT NULL`;
  }
  if (filter.value === undefined)
    throw new DatasetQueryError(`${filter.operator} requires a value`);
  if (filter.operator === 'in' || filter.operator === 'notIn') {
    if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 25) {
      throw new DatasetQueryError(`${filter.operator} requires 1-25 values`);
    }
    const values = filter.value.map((value, index) =>
      requireScalar(value, `${filter.field}[${index}]`)
    );
    const valueSql = sql.join(
      values.map(value => sql`${value}`),
      sql`, `
    );
    return filter.operator === 'in'
      ? sql`${field.expression} IN (${valueSql})`
      : sql`${field.expression} NOT IN (${valueSql})`;
  }
  const value = requireScalar(filter.value, filter.field);
  if (filter.operator === 'contains' || filter.operator === 'startsWith') {
    if (!field.searchable || typeof value !== 'string') {
      throw new DatasetQueryError(`${filter.operator} is not allowed for ${filter.field}`);
    }
    const needle = value.toLowerCase();
    return filter.operator === 'contains'
      ? sql`POSITION(${needle} IN lower(coalesce(${field.expression}::text, ''))) > 0`
      : sql`LEFT(lower(coalesce(${field.expression}::text, '')), length(${needle})) = ${needle}`;
  }
  if (filter.operator === 'eq') return sql`${field.expression} = ${value}`;
  if (filter.operator === 'neq') return sql`${field.expression} <> ${value}`;
  if (filter.operator === 'gt') return sql`${field.expression} > ${value}`;
  if (filter.operator === 'gte') return sql`${field.expression} >= ${value}`;
  if (filter.operator === 'lt') return sql`${field.expression} < ${value}`;
  return sql`${field.expression} <= ${value}`;
}

function bucketExpression(
  bucket: NonNullable<QueryKiloDatasetInput['bucket']>,
  createdAt: SQL
): SQL {
  if (bucket === 'hour') {
    return sql`DATE_TRUNC('hour', ${createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  }
  if (bucket === 'day') {
    return sql`DATE_TRUNC('day', ${createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
  }
  return sql`DATE_TRUNC('week', ${createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

function rowsFromExecute(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  if (typeof result === 'object' && result && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  }
  return [];
}

function serializeValue(value: unknown, type: ColumnType): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (type === 'timestamp') return new Date(String(value)).toISOString();
  if (type === 'integer') return Number(value);
  if (type === 'decimal') return String(value);
  if (type === 'boolean') return Boolean(value);
  return String(value);
}

function serializeRows(
  rows: Array<Record<string, unknown>>,
  columns: QueryKiloDatasetColumn[]
): Array<Record<string, string | number | boolean | null>> {
  return rows.map(row => {
    const output: Record<string, string | number | boolean | null> = {};
    for (const column of columns) {
      output[column.name] = serializeValue(row[column.name], column.type);
    }
    return output;
  });
}

export async function queryKiloDatasetStats(params: {
  user: User;
  input: unknown;
  now?: Date;
}): Promise<QueryKiloDatasetOutput> {
  const input = QueryKiloDatasetInputSchema.parse(params.input);
  if (input.mode === 'aggregate' && input.bucket) {
    throw new DatasetQueryError('aggregate mode does not accept bucket');
  }
  if (input.mode === 'timeseries' && !input.bucket) {
    throw new DatasetQueryError('timeseries mode requires bucket');
  }
  const range = normalizeRange(input.range, params.now ?? new Date());
  const catalog = resolveCatalog(input.dataset, params.user, range);
  const selectParts: SQL[] = [];
  const groupParts: SQL[] = [];
  const columns: QueryKiloDatasetColumn[] = [];
  const selectedAliases = new Set<string>();

  if (input.mode === 'timeseries') {
    const bucketName = input.bucket;
    if (!bucketName) throw new DatasetQueryError('timeseries mode requires bucket');
    const createdAt = catalog.fields.createdAt;
    if (!createdAt) throw new DatasetQueryError('dataset has no createdAt field');
    const bucket = bucketExpression(bucketName, createdAt.expression);
    selectParts.push(sql`${bucket} AS ${sql.identifier('bucketStart')}`);
    groupParts.push(bucket);
    columns.push({ name: 'bucketStart', type: 'timestamp', nullable: false });
    selectedAliases.add('bucketStart');
  }

  for (const fieldName of input.groupBy ?? []) {
    const field = catalog.fields[fieldName];
    if (!field?.group) throw new DatasetQueryError(`group field is not allowed: ${fieldName}`);
    if (selectedAliases.has(fieldName))
      throw new DatasetQueryError(`duplicate output field: ${fieldName}`);
    selectParts.push(sql`${field.expression} AS ${sql.identifier(fieldName)}`);
    groupParts.push(field.expression);
    columns.push({ name: fieldName, type: field.type, nullable: field.nullable });
    selectedAliases.add(fieldName);
  }

  for (const metric of input.metrics) {
    const alias = metricAlias(metric);
    if (selectedAliases.has(alias)) throw new DatasetQueryError(`duplicate output field: ${alias}`);
    const field = metric.field ? catalog.fields[metric.field] : undefined;
    const expression = metricExpression(metric, catalog);
    selectParts.push(sql`${expression} AS ${sql.identifier(alias)}`);
    columns.push({
      name: alias,
      type: metricOutputType(metric.operation, field),
      nullable:
        metric.operation === 'avg' || metric.operation === 'min' || metric.operation === 'max',
    });
    selectedAliases.add(alias);
  }

  const whereParts = [...catalog.mandatoryWhere];
  for (const filter of input.filters ?? []) {
    whereParts.push(compileFilter(filter, catalog));
  }

  const orderParts: SQL[] = [];
  for (const order of input.orderBy ?? []) {
    const allowed = selectedAliases.has(order.field);
    if (!allowed) throw new DatasetQueryError(`order field is not selected: ${order.field}`);
    orderParts.push(
      sql`${sql.identifier(order.field)} ${order.direction === 'asc' ? sql`ASC` : sql`DESC`}`
    );
  }
  if (orderParts.length === 0 && input.mode === 'timeseries') {
    orderParts.push(sql`${sql.identifier('bucketStart')} ASC`);
  }

  const limit = input.limit ?? 50;
  const query = sql`
    SELECT ${sql.join(selectParts, sql`, `)}
    FROM ${catalog.from}
    ${whereParts.length > 0 ? sql`WHERE ${sql.join(whereParts, sql` AND `)}` : sql``}
    ${groupParts.length > 0 ? sql`GROUP BY ${sql.join(groupParts, sql`, `)}` : sql``}
    ${orderParts.length > 0 ? sql`ORDER BY ${sql.join(orderParts, sql`, `)}` : sql``}
    LIMIT ${limit}
  `;
  const rawRows = await timedUsageQuery(
    {
      db: readDb,
      route: 'mcp.queryKiloDatasetStats',
      queryLabel: `mcp_dataset_${input.dataset}_${input.mode}`,
      scope: 'user',
      period: `${range.startDate}/${range.endDate}`,
    },
    tx => tx.execute(query)
  );

  return {
    dataset: input.dataset,
    mode: input.mode,
    scope: { type: 'me' },
    range: { startDate: range.startDate, endDate: range.endDate, timeField: 'createdAt' },
    columns,
    rows: serializeRows(rowsFromExecute(rawRows), columns),
  };
}
