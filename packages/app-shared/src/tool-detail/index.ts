import type { ToolPart } from '../opencode.gen';

export type ToolDetailField = { key: string; value: string };

export type ToolDetailSummary = { name: string; summary?: string };

export type ToolDetail = {
  status: 'pending' | 'running' | 'completed' | 'error';
  name: string;
  summary?: string;
  arguments?: Record<string, unknown>;
  fields: ToolDetailField[];
  output?: { text: string; isJson: boolean };
  error?: string;
};

/**
 * Friendly names for the image MCP tools. The slash keys cover the MCP
 * envelope (`server_name/tool_name`); the underscore keys cover a session that
 * reports the tool id directly.
 */
const knownTools = new Map([
  ['app-builder-images/transfer_image', 'Publish Image'],
  ['app-builder-images/get_image', 'Analyze Image'],
  ['app-builder-images_transfer_image', 'Publish Image'],
  ['app-builder-images_get_image', 'Analyze Image'],
]);

const labelKeys = ['description', 'query', 'url', 'filePath', 'path', 'pattern', 'name'];

const DEFAULT_VALUE_MAX_LENGTH = 4000;
const MAX_JSON_OUTPUT_LENGTH = 20000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function resolveName(tool: string, input: Record<string, unknown>): string {
  const byTool = knownTools.get(tool);
  if (byTool !== undefined) return byTool;

  if (tool === 'mcp') {
    const serverName = typeof input.server_name === 'string' ? input.server_name : undefined;
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : undefined;
    if (serverName?.trim() && toolName?.trim()) {
      const key = `${serverName}/${toolName}`;
      return knownTools.get(key) ?? key;
    }
  }

  return tool;
}

function resolveArguments(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool === 'mcp' && isRecord(input.arguments)) {
    return input.arguments;
  }
  return input;
}

function questionSummary(input: Record<string, unknown>): string | undefined {
  const questions = input.questions;
  if (Array.isArray(questions) && isRecord(questions[0])) {
    const firstQuestion = questions[0].question;
    if (typeof firstQuestion === 'string' && firstQuestion.trim().length > 0) {
      return firstQuestion;
    }
  }
  if (typeof input.question === 'string' && input.question.trim().length > 0) {
    return input.question;
  }
  return undefined;
}

function getArgumentSummary(args: Record<string, unknown>): string | undefined {
  const label = labelKeys
    .map(key => args[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const scalar = Object.entries(args).find(
    ([key, value]) =>
      !labelKeys.includes(key) &&
      ((typeof value === 'string' && value.trim().length > 0) ||
        (typeof value === 'number' && Number.isFinite(value)) ||
        typeof value === 'boolean')
  );
  const summary = [label, scalar ? `${scalar[0]}=${String(scalar[1])}` : undefined]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return summary === '' ? undefined : collapseWhitespace(summary);
}

/**
 * The object `getArgumentSummary` reads. An `mcp` part carries its payload in
 * `arguments`; `server_name`/`tool_name` are the envelope that names the call.
 * When `arguments` is missing or not a record, the raw input is the sheet's
 * fallback, but its envelope must not become the row summary: an incomplete
 * envelope would otherwise label the row `server_name=github` in place of the
 * tool name `mcp`.
 */
function summaryArguments(
  tool: string,
  input: Record<string, unknown>,
  args: Record<string, unknown>
): Record<string, unknown> {
  if (tool === 'mcp' && !isRecord(input.arguments)) return {};
  return args;
}

/**
 * The name and collapsed summary `buildToolDetail` derives, shared by the full
 * detail and the cheap summary projection.
 */
function resolveNameAndSummary(
  tool: string,
  input: Record<string, unknown>,
  args: Record<string, unknown>
): ToolDetailSummary {
  const summary =
    tool === 'question'
      ? questionSummary(input)
      : getArgumentSummary(summaryArguments(tool, input, args));
  const result: ToolDetailSummary = { name: resolveName(tool, input) };
  if (summary !== undefined) result.summary = collapseWhitespace(summary);
  return result;
}

/**
 * The name and summary alone. The transcript row renders only this pair, so it
 * must not pay for `buildToolDetail`'s field projection or the completed-output
 * JSON parse, regex scan, and pretty-print on every render and streaming tick.
 */
export function buildToolDetailSummary(part: Pick<ToolPart, 'tool' | 'state'>): ToolDetailSummary {
  const { tool, state } = part;
  return resolveNameAndSummary(tool, state.input, resolveArguments(tool, state.input));
}

function formatQuestionOption(option: unknown): string | undefined {
  if (!isRecord(option) || typeof option.label !== 'string') return undefined;
  const description = typeof option.description === 'string' ? option.description : '';
  return description.trim().length > 0 ? `${option.label} — ${description}` : option.label;
}

function formatQuestionOptions(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  const parts = options
    .map(formatQuestionOption)
    .filter((part): part is string => part !== undefined && part.length > 0);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function buildQuestionFields(input: Record<string, unknown>): ToolDetailField[] {
  const fields: ToolDetailField[] = [];
  const questions = input.questions;
  if (Array.isArray(questions)) {
    // The sheet renders one flat label/value list, so with two or more
    // questions an unprefixed `options` row reads as if it belonged to every
    // question. Number each question's rows so header/question/options stay
    // grouped; a single question keeps the plain, unnumbered keys.
    const numbered = questions.length > 1;
    for (let index = 0; index < questions.length; index += 1) {
      const entry: unknown = questions[index];
      if (!isRecord(entry)) continue;
      const ordinal = numbered ? ` ${index + 1}` : '';
      if (typeof entry.header === 'string' && entry.header.trim().length > 0) {
        fields.push({ key: `header${ordinal}`, value: entry.header });
      }
      if (typeof entry.question === 'string') {
        fields.push({ key: `question${ordinal}`, value: entry.question });
      }
      const options = formatQuestionOptions(entry.options);
      if (options !== undefined) {
        fields.push({ key: `options${ordinal}`, value: options });
      }
    }
    return fields;
  }
  if (typeof input.question === 'string') {
    fields.push({ key: 'question', value: input.question });
  }
  const options = formatQuestionOptions(input.options);
  if (options !== undefined) {
    fields.push({ key: 'options', value: options });
  }
  return fields;
}

function formatFieldValue(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function capValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}…`;
}

function buildArgumentFields(args: Record<string, unknown>, maxLength: number): ToolDetailField[] {
  const keys = Object.keys(args);
  const orderedKeys = [
    ...labelKeys.filter(key => keys.includes(key)),
    ...keys.filter(key => !labelKeys.includes(key)),
  ];
  return orderedKeys.map(key => ({
    key,
    value: capValue(formatFieldValue(args[key]), maxLength),
  }));
}

/**
 * Web's numeric round-trip guard: a JSON number literal that `JSON.stringify`
 * cannot reproduce exactly (a large integer, `1.0`, `-0`, an overflowing
 * exponent) must not be pretty-printed, because the round-trip would rewrite
 * it. String tokens are matched first so digits inside strings are ignored.
 */
const numberLiteralPattern = /"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function hasImpreciseNumberLiteral(text: string): boolean {
  for (const token of text.matchAll(numberLiteralPattern)) {
    const numberLiteral = token[1];
    if (numberLiteral !== undefined && JSON.stringify(Number(numberLiteral)) !== numberLiteral) {
      return true;
    }
  }
  return false;
}

export function formatToolDetailOutput(text: string): { text: string; isJson: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { text, isJson: false };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') {
      return { text, isJson: false };
    }
    if (hasImpreciseNumberLiteral(trimmed)) {
      return { text, isJson: false };
    }
    const pretty = JSON.stringify(parsed, null, 2);
    if (pretty === undefined || pretty.length > MAX_JSON_OUTPUT_LENGTH) {
      return { text, isJson: false };
    }
    return { text: pretty, isJson: true };
  } catch {
    return { text, isJson: false };
  }
}

export function buildToolDetail(
  part: Pick<ToolPart, 'tool' | 'state'>,
  options?: { valueMaxLength?: number }
): ToolDetail {
  const { tool, state } = part;
  const input = state.input;
  const args = resolveArguments(tool, input);
  const maxLength = options?.valueMaxLength ?? DEFAULT_VALUE_MAX_LENGTH;

  const projectedFields =
    tool === 'question'
      ? buildQuestionFields(input).map(field => ({
          key: field.key,
          value: capValue(field.value, maxLength),
        }))
      : buildArgumentFields(args, maxLength);
  // A parameterless MCP call (`arguments: {}`) or a `question` with an empty
  // `questions` array projects to no fields at all. The raw input still names
  // the call, so fall back to it rather than opening a titled but blank sheet.
  const fields =
    projectedFields.length === 0 && Object.keys(input).length > 0
      ? buildArgumentFields(input, maxLength)
      : projectedFields;

  const { name, summary } = resolveNameAndSummary(tool, input, args);
  const detail: ToolDetail = {
    status: state.status,
    name,
    arguments: args,
    fields,
  };
  if (summary !== undefined) detail.summary = summary;
  if (state.status === 'completed' && state.output.trim().length > 0) {
    detail.output = formatToolDetailOutput(state.output);
  }
  if (state.status === 'error') {
    detail.error = state.error;
  }
  return detail;
}
