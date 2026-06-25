const RAW_FUNCTION_CALL_START = '<function_calls>';
const RAW_FUNCTION_CALL_END = '</function_calls>';
const RAW_FUNCTION_RESULT_START = '<function_result>';
const RAW_FUNCTION_RESULT_END = '</function_result>';
const RAW_USAGE_RENDER_TOOL_NAME = 'kilo_usage_render_result';

const RAW_BLOCKS = [
  { start: RAW_FUNCTION_CALL_START, end: RAW_FUNCTION_CALL_END },
  { start: RAW_FUNCTION_RESULT_START, end: RAW_FUNCTION_RESULT_END },
] as const;

export type RawUsageRenderResult = {
  type?: string;
  chartType?: string;
  title?: string;
  dataset?: string;
  metric?: string;
  scopeType?: string;
  startDate?: string;
  endDate?: string;
  data: Array<Record<string, string | number | boolean | null>>;
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
    .replace(/^\s*<\/function_result>\s*$/gm, '');
}

export function stripRawToolCallMarkup(text: string): string {
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
    if (end === -1) break;

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

function toScalar(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value === null) return null;
  return undefined;
}

function toRows(
  value: unknown
): Array<Record<string, string | number | boolean | null>> | undefined {
  if (!Array.isArray(value)) return undefined;

  const rows: Array<Record<string, string | number | boolean | null>> = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;

    const row: Record<string, string | number | boolean | null> = {};
    for (const [key, rawValue] of Object.entries(item)) {
      const scalar = toScalar(rawValue);
      if (scalar === undefined) return undefined;
      row[key] = scalar;
    }
    rows.push(row);
  }

  return rows;
}

function stringParam(params: Map<string, string>, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value ? value : undefined;
}

function parseRawUsageRenderResult(body: string): RawUsageRenderResult | undefined {
  const params = new Map<string, string>();
  for (const match of body.matchAll(/<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g)) {
    params.set(match[1], match[2]);
  }

  const parsedData = parseJson(params.get('data') ?? '');
  const data = toRows(parsedData);
  if (!data) return undefined;

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

  return results;
}
