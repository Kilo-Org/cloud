import type { QueryKiloDatasetInput, QueryKiloDatasetOutput } from '@/lib/kilo-datasets/contracts';

type DatasetName = QueryKiloDatasetOutput['dataset'];
type DatasetMode = QueryKiloDatasetOutput['mode'];
type MetricOperation = QueryKiloDatasetInput['metrics'][number]['operation'];
type ScalarValue = string | number | boolean | null;

export type KiloDatasetRenderModeLabelInput =
  | 'metric-grid'
  | 'bar-chart'
  | 'timeseries-chart'
  | 'table';

const datasetLabels: Record<string, string> = {
  microdollar_usage: 'Model usage',
  code_reviews: 'Code Reviewer',
  cloud_sessions: 'Cloud Agent sessions',
  cli_sessions: 'CLI sessions',
  vscode_sessions: 'VS Code sessions',
} satisfies Record<DatasetName, string>;

const modeLabels: Record<string, string> = {
  aggregate: 'Breakdown',
  timeseries: 'Trend',
} satisfies Record<DatasetMode, string>;

const renderModeLabels: Record<string, string> = {
  'metric-grid': 'Summary',
  'bar-chart': 'Breakdown',
  'timeseries-chart': 'Trend',
  table: 'Table',
} satisfies Record<KiloDatasetRenderModeLabelInput, string>;

const operationLabels: Record<string, string> = {
  count: 'Count',
  countDistinct: 'Unique',
  sum: 'Total',
  avg: 'Average',
  min: 'Minimum',
  max: 'Maximum',
} satisfies Record<MetricOperation, string>;

const fieldLabels: Record<string, string> = {
  agentVersion: 'Agent version',
  bucketStart: 'Date',
  cacheHitTokens: 'Cache hit tokens',
  cacheWriteTokens: 'Cache write tokens',
  completedAt: 'Completed at',
  costMicrodollars: 'Cost',
  costUsd: 'Cost',
  createdAt: 'Date',
  gitBranch: 'Branch',
  gitUrl: 'Git remote',
  hasError: 'Result',
  inferenceProvider: 'Inference provider',
  inputTokens: 'Input tokens',
  isRoot: 'Session type',
  label: 'Label',
  lastMode: 'Last mode',
  lastModel: 'Last model',
  model: 'Model',
  organizationId: 'Organization',
  outputTokens: 'Output tokens',
  platform: 'Platform',
  projectId: 'Project',
  provider: 'Provider',
  repository: 'Repository',
  repositoryReviewInstructionsUsed: 'Repository instructions',
  sourceVersion: 'Source version',
  startedAt: 'Started at',
  status: 'Status',
  terminalReason: 'Completion reason',
  totalCostMicrodollars: 'Cost',
  totalCostUsd: 'Cost',
  totalInputTokens: 'Input tokens',
  totalOutputTokens: 'Output tokens',
  updatedAt: 'Updated at',
  version: 'Version',
};

const friendlyTextReplacements: Array<[string, string]> = [
  ['totalCostMicrodollars', 'Cost'],
  ['totalCostUsd', 'Cost'],
  ['costMicrodollars', 'Cost'],
  ['costUsd', 'Cost'],
  ['microdollar_usage', 'model usage'],
  ['code_reviews', 'Code Reviewer'],
  ['bucketStart', 'date'],
];

function fallbackLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function countLabel(dataset: string | undefined): string {
  if (dataset === 'code_reviews') return 'Reviews';
  if (dataset === 'cloud_sessions' || dataset === 'cli_sessions' || dataset === 'vscode_sessions') {
    return 'Sessions';
  }
  return 'Requests';
}

function metricLabel(operation: string, field: string): string {
  const fieldLabel = getKiloDatasetColumnLabel(field);
  if (operation === 'sum') return fieldLabel;
  const operationLabel = operationLabels[operation] ?? fallbackLabel(operation);
  return `${operationLabel} ${lowerFirst(fieldLabel)}`;
}

function metricAliasLabel(columnName: string): string | undefined {
  const separatorIndex = columnName.indexOf('_');
  if (separatorIndex === -1) return undefined;

  const operation = columnName.slice(0, separatorIndex);
  if (!operationLabels[operation]) return undefined;

  const field = columnName.slice(separatorIndex + 1);
  if (!field) return undefined;
  return metricLabel(operation, field);
}

export function getKiloDatasetNameLabel(dataset: string | undefined): string {
  if (!dataset) return 'Usage result';
  return datasetLabels[dataset] ?? fallbackLabel(dataset);
}

export function getKiloDatasetModeLabel(mode: string): string {
  return modeLabels[mode] ?? fallbackLabel(mode);
}

export function getKiloDatasetRenderModeLabel(mode: string): string {
  return renderModeLabels[mode] ?? fallbackLabel(mode);
}

export function getKiloDatasetColumnLabel(
  columnName: string,
  dataset: string | undefined = undefined
): string {
  if (columnName === 'count') return countLabel(dataset);
  return metricAliasLabel(columnName) ?? fieldLabels[columnName] ?? fallbackLabel(columnName);
}

export function getKiloDatasetScalarValueLabel(
  columnName: string,
  value: ScalarValue
): string | undefined {
  if (value === null) return 'No data';
  if (typeof value !== 'boolean') return undefined;

  if (columnName === 'hasError') return value ? 'Errored' : 'Successful';
  if (columnName === 'isRoot') return value ? 'Root session' : 'Child session';
  if (columnName === 'repositoryReviewInstructionsUsed') return value ? 'Used' : 'Not used';
  return value ? 'Yes' : 'No';
}

export function getKiloDatasetFriendlyText(text: string): string {
  return friendlyTextReplacements.reduce(
    (label, [internalName, replacement]) => label.replaceAll(internalName, replacement),
    text
  );
}
