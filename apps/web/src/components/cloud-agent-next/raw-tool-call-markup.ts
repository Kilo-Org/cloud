const RAW_FUNCTION_CALL_START = '<function_calls>';
const RAW_FUNCTION_CALL_END = '</function_calls>';
const RAW_FUNCTION_RESULT_START = '<function_result>';
const RAW_FUNCTION_RESULT_END = '</function_result>';
const RAW_FUNCTION_RETURN_START = '<function_return>';
const RAW_FUNCTION_RETURN_END = '</function_return>';
const RAW_FUNCTION_RETURNS_START = '<function_returns>';
const RAW_FUNCTION_RETURNS_END = '</function_returns>';
const RAW_USAGE_RENDER_TOOL_NAME = 'kilo_usage_render_result';
const RAW_DATASET_QUERY_TOOL_NAMES = [
  'kilo_usage__query_kilo_dataset',
  'kilo_usage_query_kilo_dataset',
  'query_kilo_dataset',
] as const;

type Scalar = string | number | boolean | null;

const RAW_BLOCKS = [
  { start: RAW_FUNCTION_CALL_START, end: RAW_FUNCTION_CALL_END },
  { start: RAW_FUNCTION_RESULT_START, end: RAW_FUNCTION_RESULT_END },
  { start: RAW_FUNCTION_RETURN_START, end: RAW_FUNCTION_RETURN_END },
  { start: RAW_FUNCTION_RETURNS_START, end: RAW_FUNCTION_RETURNS_END },
] as const;

const RAW_JSON_RESULT_STARTS = [RAW_FUNCTION_RETURN_START, RAW_FUNCTION_RETURNS_START] as const;

export type RawUsageRenderResult = {
  type?: string;
  chartType?: string;
  title?: string;
  dataset?: string;
  metric?: string;
  scopeType?: string;
  startDate?: string;
  endDate?: string;
  data: Array<Record<string, Scalar>>;
};

function nextRawBlock(
  text: string,
  cursor: number
): { startIndex: number; endTag: string } | undefined {
  let next: { startIndex: number; endTag: string } | undefined;

  for (const block of RAW_BLOCKS) {
    const startIndex = text.indexOf(block.start, cursor);
    if (startIndex === -1) continue;
    if (!next || startIndex < next.startIndex) {
      next = { startIndex, endTag: block.end };
    }
  }

  return next;
}

function stripOrphanRawTags(text: string): string {
  return text
    .replace(/^\s*<\/function_calls>\s*$/gm, '')
    .replace(/^\s*<\/function_result>\s*$/gm, '')
    .replace(/^\s*<\/function_return>\s*$/gm, '')
    .replace(/^\s*<\/function_returns>\s*$/gm, '')
    .replace(/^\s*<\/parameter>\s*<\/invoke>\s*$/gm, '');
}

export function stripRawToolCallMarkup(
  text: string,
  options?: { preserveWhenNoRenderableResults?: boolean }
): string {
  if (options?.preserveWhenNoRenderableResults && extractRawUsageRenderResults(text).length === 0) {
    return text.trim();
  }

  let output = '';
  let cursor = 0;

  while (cursor < text.length) {
    const block = nextRawBlock(text, cursor);
    if (!block) {
      output += text.slice(cursor);
      break;
    }

    const lineStart = text.lastIndexOf('\n', block.startIndex) + 1;
    output += text.slice(cursor, lineStart);

    const end = text.indexOf(block.endTag, block.startIndex);
    if (end === -1) {
      const nextLine = text.indexOf('\n', block.startIndex);
      if (nextLine === -1) break;
      cursor = nextLine + 1;
      continue;
    }

    const afterEnd = end + block.endTag.length;
    const nextLine = text.indexOf('\n', afterEnd);
    cursor = nextLine === -1 ? text.length : nextLine + 1;
  }

  return stripOrphanRawTags(output)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toScalar(value: unknown): Scalar | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value === null) return null;
  return undefined;
}

function toRows(value: unknown): Array<Record<string, Scalar>> | undefined {
  if (!Array.isArray(value)) return undefined;

  const rows: Array<Record<string, Scalar>> = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;

    const row: Record<string, Scalar> = {};
    for (const [key, rawValue] of Object.entries(item)) {
      const scalar = toScalar(rawValue);
      if (scalar === undefined) return undefined;
      row[key] = scalar;
    }
    rows.push(row);
  }

  return rows;
}

function toScalarArray(value: unknown[]): Scalar[] | undefined {
  const scalars: Scalar[] = [];
  for (const item of value) {
    const scalar = toScalar(item);
    if (scalar === undefined) return undefined;
    scalars.push(scalar);
  }
  return scalars;
}

function stringParam(params: Map<string, string>, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value ? value : undefined;
}

function paramsFromInvokeBody(body: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const match of body.matchAll(/<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g)) {
    params.set(match[1], match[2]);
  }
  return params;
}

function stringFromValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function findJsonObjectEnd(text: string, objectStart: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = objectStart; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return index + 1;
    }
  }

  return undefined;
}

function extractRawJsonResults(text: string): unknown[] {
  const results: unknown[] = [];

  for (const startToken of RAW_JSON_RESULT_STARTS) {
    let cursor = 0;
    while (cursor < text.length) {
      const startIndex = text.indexOf(startToken, cursor);
      if (startIndex === -1) break;

      const objectStart = text.indexOf('{', startIndex + startToken.length);
      if (objectStart === -1) break;

      const objectEnd = findJsonObjectEnd(text, objectStart);
      if (objectEnd === undefined) break;

      const parsed = parseJson(text.slice(objectStart, objectEnd));
      if (parsed !== undefined) results.push(parsed);
      cursor = objectEnd;
    }
  }

  return results;
}

function rawUsageResultFromChartData(value: unknown): RawUsageRenderResult | undefined {
  if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.labels)) {
    return undefined;
  }

  const datasets = Array.isArray(value.data.datasets) ? value.data.datasets : [];
  const labels = toScalarArray(value.data.labels);
  if (!labels || datasets.length === 0) return undefined;

  const parsedDatasets: Array<{ label: string; data: Scalar[] }> = [];
  for (const dataset of datasets) {
    if (!isRecord(dataset) || !Array.isArray(dataset.data)) return undefined;
    const label = stringFromValue(dataset.label);
    if (!label) return undefined;
    const data = toScalarArray(dataset.data);
    if (!data) return undefined;
    parsedDatasets.push({ label, data });
  }

  const rows: Array<Record<string, Scalar>> = [];
  for (const [index, label] of labels.entries()) {
    const row: Record<string, Scalar> = { label };
    for (const dataset of parsedDatasets) {
      row[dataset.label] = dataset.data[index] ?? null;
    }
    rows.push(row);
  }

  return {
    type: stringFromValue(value.type) ?? 'chart',
    chartType: stringFromValue(value.chartType),
    title: stringFromValue(value.title),
    dataset: stringFromValue(value.dataset),
    metric: parsedDatasets[0]?.label,
    scopeType: stringFromValue(value.scopeType),
    startDate: stringFromValue(value.startDate),
    endDate: stringFromValue(value.endDate),
    data: rows,
  };
}

function parseRawUsageRenderResult(body: string): RawUsageRenderResult | undefined {
  const params = paramsFromInvokeBody(body);

  const parsedData = parseJson(params.get('data') ?? '');
  const data = toRows(parsedData);
  if (!data) {
    return rawUsageResultFromChartData({
      type: stringParam(params, 'type'),
      chartType: stringParam(params, 'chartType'),
      title: stringParam(params, 'title'),
      dataset: stringParam(params, 'dataset'),
      metric: stringParam(params, 'metric'),
      scopeType: stringParam(params, 'scopeType'),
      startDate: stringParam(params, 'startDate'),
      endDate: stringParam(params, 'endDate'),
      data: parsedData,
    });
  }

  return {
    type: stringParam(params, 'type'),
    chartType: stringParam(params, 'chartType'),
    title: stringParam(params, 'title'),
    dataset: stringParam(params, 'dataset'),
    metric: stringParam(params, 'metric'),
    scopeType: stringParam(params, 'scopeType'),
    startDate: stringParam(params, 'startDate'),
    endDate: stringParam(params, 'endDate'),
    data,
  };
}

function metricAliasFromParams(params: Map<string, string>): string | undefined {
  const parsedMetrics = parseJson(params.get('metrics') ?? '');
  if (!Array.isArray(parsedMetrics)) return undefined;

  const firstMetric = parsedMetrics[0];
  if (!isRecord(firstMetric) || typeof firstMetric.operation !== 'string') return undefined;
  if (firstMetric.operation === 'count') return 'count';
  if (typeof firstMetric.field !== 'string' || firstMetric.field.length === 0) return undefined;
  return `${firstMetric.operation}_${firstMetric.field}`;
}

function firstNumericColumn(rows: Array<Record<string, Scalar>>): string | undefined {
  const firstRow = rows[0];
  if (!firstRow) return undefined;
  return Object.keys(firstRow).find(key => {
    const value = firstRow[key];
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'string' || value.trim() === '') return false;
    return Number.isFinite(Number(value));
  });
}

function rawUsageResultFromDatasetQuery(
  params: Map<string, string>,
  value: unknown
): RawUsageRenderResult | undefined {
  if (!isRecord(value)) return undefined;

  const rows = toRows(value.rows);
  if (!rows) return undefined;

  const mode = stringFromValue(value.type) ?? stringParam(params, 'mode');
  const metric = metricAliasFromParams(params) ?? firstNumericColumn(rows);
  const isTimeseries = mode === 'timeseries' || stringParam(params, 'bucket') !== undefined;
  const title = metric?.toLowerCase().includes('cost') ? 'Cost over time' : undefined;

  return {
    type: isTimeseries ? 'chart' : undefined,
    chartType: isTimeseries ? 'bar' : undefined,
    title,
    dataset: stringParam(params, 'dataset'),
    metric,
    scopeType: stringFromValue(value.scopeType),
    startDate: stringParam(params, 'startDate'),
    endDate: stringParam(params, 'endDate'),
    data: rows,
  };
}

function extractRawDatasetQueryResults(text: string): RawUsageRenderResult[] {
  const results: RawUsageRenderResult[] = [];
  const toolNamesPattern = RAW_DATASET_QUERY_TOOL_NAMES.join('|');
  const invokePattern = new RegExp(
    `<invoke name="(${toolNamesPattern})">([\\s\\S]*?)</invoke>`,
    'g'
  );

  for (const match of text.matchAll(invokePattern)) {
    const invokeEnd = (match.index ?? 0) + match[0].length;
    const resultStart = text.indexOf(RAW_FUNCTION_RESULT_START, invokeEnd);
    if (resultStart === -1) continue;

    const objectStart = text.indexOf('{', resultStart + RAW_FUNCTION_RESULT_START.length);
    if (objectStart === -1) continue;

    const objectEnd = findJsonObjectEnd(text, objectStart);
    if (objectEnd === undefined) continue;

    const parsedResult = parseJson(text.slice(objectStart, objectEnd));
    const result = rawUsageResultFromDatasetQuery(paramsFromInvokeBody(match[2]), parsedResult);
    if (result) results.push(result);
  }

  return results;
}

export function extractRawUsageRenderResults(text: string): RawUsageRenderResult[] {
  const results: RawUsageRenderResult[] = [];
  const pattern = new RegExp(
    `<invoke name="${RAW_USAGE_RENDER_TOOL_NAME}">([\\s\\S]*?)<\\/invoke>`,
    'g'
  );

  for (const match of text.matchAll(pattern)) {
    const result = parseRawUsageRenderResult(match[1]);
    if (result) results.push(result);
  }

  for (const rawResult of extractRawJsonResults(text)) {
    const result = rawUsageResultFromChartData(rawResult);
    if (result) results.push(result);
  }

  results.push(...extractRawDatasetQueryResults(text));

  return results;
}
