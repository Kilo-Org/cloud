import 'server-only';
import type {
  DescribeKiloDatasetInput,
  GetKiloUsageCostInput,
  QueryKiloDatasetColumn,
  QueryKiloDatasetInput,
} from './contracts';

type DatasetName = QueryKiloDatasetInput['dataset'];
type ColumnType = QueryKiloDatasetColumn['type'];
type FieldCapability = 'filter' | 'group' | 'metric' | 'search';

type PublicFieldDescription = {
  name: string;
  type: ColumnType;
  nullable: boolean;
  description: string;
  capabilities: FieldCapability[];
};

type QueryExample = {
  title: string;
  description: string;
  input: QueryKiloDatasetInput;
};

type QueryDatasetRecipe = {
  id: string;
  title: string;
  description: string;
  useWhen: string[];
  tool: 'query_kilo_dataset';
  input: QueryKiloDatasetInput;
};

type UsageCostRecipe = {
  id: string;
  title: string;
  description: string;
  useWhen: string[];
  tool: 'get_kilo_usage_cost';
  input: GetKiloUsageCostInput;
};

type DatasetRecipe = QueryDatasetRecipe | UsageCostRecipe;

type DatasetDescription = {
  name: DatasetName;
  description: string;
  timeField: 'createdAt';
  metricFields: string[];
  groupFields: string[];
  searchableFields: string[];
  fields: PublicFieldDescription[];
  notes: string[];
  examples?: QueryExample[];
};

export type DescribeKiloDatasetOutput = {
  datasets: DatasetDescription[];
  recipes?: DatasetRecipe[];
  rules: {
    scope: { type: 'me' };
    range: string[];
    modes: string[];
    metrics: string[];
    ordering: string[];
    caps: string[];
  };
};

const commonRules: DescribeKiloDatasetOutput['rules'] = {
  scope: { type: 'me' },
  range: [
    'All queries filter createdAt with a half-open interval: createdAt >= startDate and createdAt < endDate.',
    'If range is omitted, endDate defaults to now and startDate defaults to 60 days before endDate.',
    'The maximum range is 60 days. Timestamps are normalized to UTC ISO strings.',
  ],
  modes: [
    'aggregate returns one or more metric rows, optionally grouped by public group fields. Do not include bucket.',
    'timeseries returns UTC buckets and includes bucketStart. Include bucket: hour, day, or week.',
  ],
  metrics: [
    'For usage cost, prefer get_kilo_usage_cost. It derives valid aggregate or timeseries query_kilo_dataset inputs for common cost questions.',
    'count counts rows and must be written as { "operation": "count" } with no field.',
    'sum, avg, min, max, and countDistinct require a metric field approved for the selected dataset.',
    'Metric output aliases are count or <operation>_<field>, such as sum_costUsd.',
  ],
  ordering: [
    'orderBy.field must be a selected output field, such as a group field, bucketStart, count, or sum_costUsd.',
    'timeseries queries default to bucketStart ascending when no orderBy is supplied.',
  ],
  caps: [
    'filters: 8; in/notIn values: 25; groupBy: 2; metrics: 5; orderBy: 2; limit: default 50 and max 100.',
    'contains and startsWith are available only on searchable fields.',
  ],
};

function field(
  name: string,
  type: ColumnType,
  nullable: boolean,
  description: string,
  capabilities: FieldCapability[] = ['filter']
): PublicFieldDescription {
  return { name, type, nullable, description, capabilities };
}

const microdollarUsageExamples: QueryExample[] = [
  {
    title: 'Total usage cost for a day',
    description: 'Use aggregate mode with costUsd or costMicrodollars. Do not include bucket.',
    input: {
      dataset: 'microdollar_usage',
      mode: 'aggregate',
      range: {
        startDate: '2026-06-22T00:00:00.000Z',
        endDate: '2026-06-23T00:00:00.000Z',
      },
      metrics: [
        { operation: 'sum', field: 'costUsd' },
        { operation: 'sum', field: 'costMicrodollars' },
      ],
    },
  },
  {
    title: 'Daily usage cost trend',
    description: 'Use timeseries mode with a required bucket.',
    input: {
      dataset: 'microdollar_usage',
      mode: 'timeseries',
      bucket: 'day',
      range: {
        startDate: '2026-06-16T00:00:00.000Z',
        endDate: '2026-06-23T00:00:00.000Z',
      },
      metrics: [{ operation: 'sum', field: 'costUsd' }],
    },
  },
  {
    title: 'Request count by model',
    description: 'count has no field and can be ordered by the count output alias.',
    input: {
      dataset: 'microdollar_usage',
      mode: 'aggregate',
      groupBy: ['model'],
      metrics: [{ operation: 'count' }],
      orderBy: [{ field: 'count', direction: 'desc' }],
    },
  },
];

const microdollarUsageRecipes: DatasetRecipe[] = [
  {
    id: 'usage_cost_yesterday',
    title: 'Usage cost for yesterday',
    description:
      'Best default for prompts like "What was my cost yesterday?". Replace UTC with the user or local IANA timezone when known.',
    useWhen: ['cost yesterday', 'spend yesterday', 'usage cost yesterday'],
    tool: 'get_kilo_usage_cost',
    input: { period: 'yesterday', timezone: 'UTC' },
  },
  {
    id: 'usage_cost_by_model_last_7_days',
    title: 'Usage cost by model',
    description:
      'Breaks recent model usage cost down by requested or routed model without hand-building groupBy metrics.',
    useWhen: ['cost by model', 'spend by model', 'model costs'],
    tool: 'get_kilo_usage_cost',
    input: { period: 'last_7_days', timezone: 'UTC', groupBy: 'model' },
  },
  {
    id: 'usage_cost_daily_trend',
    title: 'Daily usage cost trend',
    description: 'Returns bucketed cost rows for charting or trend summaries.',
    useWhen: ['daily cost trend', 'cost over time', 'usage spend trend'],
    tool: 'get_kilo_usage_cost',
    input: { period: 'last_7_days', timezone: 'UTC', bucket: 'day' },
  },
  {
    id: 'raw_usage_cost_total_day',
    title: 'Raw usage cost aggregate query',
    description:
      'Minimal valid generic query_kilo_dataset payload for a fixed UTC day. Aggregate mode must not include bucket.',
    useWhen: ['raw aggregate cost query', 'query_kilo_dataset cost example'],
    tool: 'query_kilo_dataset',
    input: {
      dataset: 'microdollar_usage',
      mode: 'aggregate',
      range: {
        startDate: '2026-06-22T00:00:00.000Z',
        endDate: '2026-06-23T00:00:00.000Z',
      },
      metrics: [
        { operation: 'sum', field: 'costUsd' },
        { operation: 'sum', field: 'costMicrodollars' },
      ],
    },
  },
];

const codeReviewExamples: QueryExample[] = [
  {
    title: 'Total Code Reviewer cost',
    description: 'Sum Code Reviewer cost over a date range.',
    input: {
      dataset: 'code_reviews',
      mode: 'aggregate',
      range: {
        startDate: '2026-06-16T00:00:00.000Z',
        endDate: '2026-06-23T00:00:00.000Z',
      },
      metrics: [{ operation: 'sum', field: 'totalCostUsd' }],
    },
  },
  {
    title: 'Code Reviewer runs by status',
    description: 'Group count results by a public status field.',
    input: {
      dataset: 'code_reviews',
      mode: 'aggregate',
      groupBy: ['status'],
      metrics: [{ operation: 'count' }],
      orderBy: [{ field: 'count', direction: 'desc' }],
    },
  },
];

function sessionExamples(dataset: DatasetName): QueryExample[] {
  return [
    {
      title: 'Session count by day',
      description: 'Session datasets support count only in the MVP.',
      input: {
        dataset,
        mode: 'timeseries',
        bucket: 'day',
        metrics: [{ operation: 'count' }],
      },
    },
  ];
}

const microdollarUsageDescription: DatasetDescription = {
  name: 'microdollar_usage',
  description: 'Your Kilo model usage, cost, token, provider, model, and project stats.',
  timeField: 'createdAt',
  metricFields: [
    'costMicrodollars',
    'costUsd',
    'inputTokens',
    'outputTokens',
    'cacheWriteTokens',
    'cacheHitTokens',
  ],
  groupFields: [
    'organizationId',
    'provider',
    'model',
    'hasError',
    'inferenceProvider',
    'projectId',
  ],
  searchableFields: ['provider', 'model', 'inferenceProvider', 'projectId'],
  fields: [
    field('organizationId', 'string', true, 'Organization attribution when present.', [
      'filter',
      'group',
    ]),
    field('createdAt', 'timestamp', false, 'Usage creation timestamp used for range filtering.'),
    field('costMicrodollars', 'integer', false, 'Exact usage cost in microdollars.', [
      'filter',
      'metric',
    ]),
    field('costUsd', 'decimal', false, 'Exact usage cost converted to USD.', ['filter', 'metric']),
    field('inputTokens', 'integer', false, 'Input token count.', ['filter', 'metric']),
    field('outputTokens', 'integer', false, 'Output token count.', ['filter', 'metric']),
    field('cacheWriteTokens', 'integer', false, 'Cache write token count.', ['filter', 'metric']),
    field('cacheHitTokens', 'integer', false, 'Cache hit token count.', ['filter', 'metric']),
    field('provider', 'string', true, 'Model provider.', ['filter', 'group', 'search']),
    field('model', 'string', true, 'Requested model when present, otherwise routed model.', [
      'filter',
      'group',
      'search',
    ]),
    field('hasError', 'boolean', false, 'Whether the usage record ended in an error.', [
      'filter',
      'group',
    ]),
    field('inferenceProvider', 'string', true, 'Inference provider when available.', [
      'filter',
      'group',
      'search',
    ]),
    field('projectId', 'string', true, 'Project attribution when available.', [
      'filter',
      'group',
      'search',
    ]),
  ],
  notes: [
    'Individual stats include your personal and organization-attributed usage.',
    'For cost questions, prefer costUsd for display and costMicrodollars for exact integer accounting.',
    'count counts usage records and does not take a field.',
  ],
  examples: microdollarUsageExamples,
};

const codeReviewsDescription: DatasetDescription = {
  name: 'code_reviews',
  description: 'Your user-owned Code Reviewer runs, statuses, models, token totals, and costs.',
  timeField: 'createdAt',
  metricFields: ['totalInputTokens', 'totalOutputTokens', 'totalCostMicrodollars', 'totalCostUsd'],
  groupFields: [
    'platform',
    'repository',
    'status',
    'terminalReason',
    'agentVersion',
    'repositoryReviewInstructionsUsed',
    'model',
  ],
  searchableFields: ['platform', 'repository', 'status', 'terminalReason', 'agentVersion', 'model'],
  fields: [
    field(
      'createdAt',
      'timestamp',
      false,
      'Code Review creation timestamp used for range filtering.'
    ),
    field('startedAt', 'timestamp', true, 'When the Code Review started.'),
    field('completedAt', 'timestamp', true, 'When the Code Review completed.'),
    field('platform', 'string', false, 'Source platform.', ['filter', 'group', 'search']),
    field('repository', 'string', false, 'Repository full name.', ['filter', 'group', 'search']),
    field('status', 'string', false, 'Code Review status.', ['filter', 'group', 'search']),
    field('terminalReason', 'string', true, 'Terminal reason when available.', [
      'filter',
      'group',
      'search',
    ]),
    field('agentVersion', 'string', true, 'Code Reviewer agent version.', [
      'filter',
      'group',
      'search',
    ]),
    field(
      'repositoryReviewInstructionsUsed',
      'boolean',
      false,
      'Whether repository review instructions were used.',
      ['filter', 'group']
    ),
    field('model', 'string', true, 'Model used by Code Reviewer.', ['filter', 'group', 'search']),
    field('totalInputTokens', 'integer', true, 'Total input tokens.', ['filter', 'metric']),
    field('totalOutputTokens', 'integer', true, 'Total output tokens.', ['filter', 'metric']),
    field('totalCostMicrodollars', 'integer', true, 'Total cost in microdollars.', [
      'filter',
      'metric',
    ]),
    field('totalCostUsd', 'decimal', true, 'Total cost converted to USD.', ['filter', 'metric']),
  ],
  notes: [
    'This intentionally excludes organization-owned Code Reviews in the current MVP.',
    'No Code Review findings, output prose, session logs, refs, SHAs, or PR titles are exposed.',
  ],
  examples: codeReviewExamples,
};

function sessionDescription(
  name: Extract<DatasetName, 'cloud_sessions' | 'cli_sessions' | 'vscode_sessions'>,
  description: string
): DatasetDescription {
  return {
    name,
    description,
    timeField: 'createdAt',
    metricFields: [],
    groupFields: [
      'organizationId',
      'platform',
      'sourceVersion',
      'gitUrl',
      'gitBranch',
      'isRoot',
      'status',
      'version',
      'lastMode',
      'lastModel',
    ],
    searchableFields: ['gitUrl', 'gitBranch', 'status', 'lastMode', 'lastModel'],
    fields: [
      field('organizationId', 'string', true, 'Organization attribution when present.', [
        'filter',
        'group',
      ]),
      field(
        'createdAt',
        'timestamp',
        false,
        'Session creation timestamp used for range filtering.'
      ),
      field('updatedAt', 'timestamp', false, 'Session update timestamp.'),
      field('platform', 'string', false, 'Normalized session platform.', ['filter', 'group']),
      field('sourceVersion', 'string', false, 'Source table version.', ['filter', 'group']),
      field('gitUrl', 'string', true, 'Git remote URL when recorded.', [
        'filter',
        'group',
        'search',
      ]),
      field('gitBranch', 'string', true, 'Git branch when recorded.', [
        'filter',
        'group',
        'search',
      ]),
      field('isRoot', 'boolean', false, 'Whether the session is a root session.', [
        'filter',
        'group',
      ]),
      field('status', 'string', true, 'Session status when recorded.', [
        'filter',
        'group',
        'search',
      ]),
      field('version', 'integer', false, 'Session schema version.', ['filter', 'group']),
      field('lastMode', 'string', true, 'Last mode recorded by legacy sessions.', [
        'filter',
        'group',
        'search',
      ]),
      field('lastModel', 'string', true, 'Last model recorded by legacy sessions.', [
        'filter',
        'group',
        'search',
      ]),
    ],
    notes: [
      'Session datasets support count only in the MVP; use metrics: [{ "operation": "count" }].',
      'Individual stats include your personal and organization-attributed sessions.',
      'Session IDs, public IDs, parent IDs, messages, snapshots, blobs, and sandbox details are not exposed.',
    ],
    examples: sessionExamples(name),
  };
}

const datasetDescriptions: Record<DatasetName, DatasetDescription> = {
  microdollar_usage: microdollarUsageDescription,
  code_reviews: codeReviewsDescription,
  cloud_sessions: sessionDescription(
    'cloud_sessions',
    'Your Cloud Agent session counts and dimensions.'
  ),
  cli_sessions: sessionDescription('cli_sessions', 'Your CLI session counts and dimensions.'),
  vscode_sessions: sessionDescription(
    'vscode_sessions',
    'Your VS Code extension session counts and dimensions.'
  ),
};

const datasetRecipes: Record<DatasetName, DatasetRecipe[]> = {
  microdollar_usage: microdollarUsageRecipes,
  code_reviews: [],
  cloud_sessions: [],
  cli_sessions: [],
  vscode_sessions: [],
};

function withoutExamples(description: DatasetDescription): DatasetDescription {
  const descriptionWithoutExamples = { ...description };
  delete descriptionWithoutExamples.examples;
  return descriptionWithoutExamples;
}

export function allowedMetricFieldsForDataset(dataset: DatasetName): string[] {
  return datasetDescriptions[dataset].metricFields;
}

export function allowedGroupFieldsForDataset(dataset: DatasetName): string[] {
  return datasetDescriptions[dataset].groupFields;
}

export function describeKiloDataset(input: DescribeKiloDatasetInput): DescribeKiloDatasetOutput {
  const includeExamples = input.includeExamples ?? true;
  const descriptions = input.dataset
    ? [datasetDescriptions[input.dataset]]
    : Object.values(datasetDescriptions);
  const recipes = descriptions.flatMap(description => datasetRecipes[description.name]);

  return {
    datasets: includeExamples ? descriptions : descriptions.map(withoutExamples),
    ...(includeExamples ? { recipes } : {}),
    rules: commonRules,
  };
}
