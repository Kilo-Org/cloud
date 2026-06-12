import { ClassifierOutputSchema, type ClassifierOutput } from '@kilocode/auto-routing-contracts';
import classifierTaxonomy from '../classifier-taxonomy.json';

export const classifierOutputSchema = ClassifierOutputSchema;
export type { ClassifierOutput };

export type ClassifierOutputParseFailureStage = 'invalid_json' | 'invalid_schema';

export class ClassifierOutputParseError extends Error {
  readonly failureStage: ClassifierOutputParseFailureStage;
  readonly schemaIssueSummary: string[];
  readonly topLevelKeys: string[];

  constructor(
    message: string,
    metadata: {
      failureStage: ClassifierOutputParseFailureStage;
      schemaIssueSummary?: string[];
      topLevelKeys?: string[];
    }
  ) {
    super(message);
    this.name = 'ClassifierOutputParseError';
    this.failureStage = metadata.failureStage;
    this.schemaIssueSummary = metadata.schemaIssueSummary ?? [];
    this.topLevelKeys = metadata.topLevelKeys ?? [];
  }
}

const taskTypes = classifierTaxonomy.taskTypes.map(taskType => ({
  id: taskType.id,
  label: taskType.label,
  subtypes: taskType.subtypes.map(subtype => ({
    id: subtype.id,
    label: subtype.label,
  })),
}));

const taskTypeByToken = new Map(
  taskTypes.flatMap(taskType => [
    [token(taskType.id), taskType.id],
    [token(taskType.label), taskType.id],
  ])
);

const subtaskByToken = new Map(
  taskTypes.flatMap(taskType =>
    taskType.subtypes.flatMap(subtype => [
      [token(subtype.id), subtype.id],
      [token(subtype.label), subtype.id],
    ])
  )
);

const taskTypeBySubtask = new Map(
  taskTypes.flatMap(taskType => taskType.subtypes.map(subtype => [subtype.id, taskType.id]))
);

const subtypesByTaskType = new Map(
  taskTypes.map(taskType => [taskType.id, taskType.subtypes.map(subtype => subtype.id)])
);

const defaultSubtaskByTaskType = new Map(
  taskTypes.map(taskType => [taskType.id, taskType.subtypes[0]?.id])
);

const contextComplexityByToken = enumMap(['small', 'medium', 'large']);
const reasoningComplexityByToken = enumMap(['low', 'medium', 'high']);
const riskLevelByToken = enumMap(['low', 'medium', 'high']);
const executionModeByToken = enumMap([
  'answer_only',
  'code_change',
  'command_execution',
  'multi_step_project',
]);

export function parseClassifierOutput(text: string): ClassifierOutput {
  const parsed = parseClassifierJson(text);
  const record = unwrapClassifierRecord(parsed);
  const normalized = normalizeClassifierOutput(record ?? parsed);
  const result = classifierOutputSchema.safeParse(normalized);
  if (!result.success) {
    throw new ClassifierOutputParseError('Classifier model returned invalid classification', {
      failureStage: 'invalid_schema',
      topLevelKeys: Object.keys(record ?? {}).slice(0, 20),
      schemaIssueSummary: result.error.issues.slice(0, 5).map(issue => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `${path}:${issue.code}`;
      }),
    });
  }

  return result.data;
}

function parseClassifierJson(text: string): unknown {
  const trimmed = text.trim();
  for (const candidate of [trimmed, stripFence(trimmed), extractFirstObject(trimmed)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  throw new ClassifierOutputParseError('Classifier model returned invalid JSON', {
    failureStage: 'invalid_json',
  });
}

function normalizeClassifierOutput(parsed: unknown): unknown {
  const record = asRecord(parsed);
  if (!record) return parsed;
  const taskType = normalizeStringEnum(field(record, 'taskType'), taskTypeByToken);
  const subtaskType = normalizeStringEnum(field(record, 'subtaskType'), subtaskByToken);
  const inferredTaskType =
    taskType ?? (subtaskType ? taskTypeBySubtask.get(subtaskType) : undefined);
  const repairedSubtaskType = repairSubtaskType(inferredTaskType, subtaskType);

  return {
    taskType: inferredTaskType,
    subtaskType: repairedSubtaskType,
    contextComplexity: normalizeStringEnum(
      field(record, 'contextComplexity'),
      contextComplexityByToken
    ),
    reasoningComplexity: normalizeStringEnum(
      field(record, 'reasoningComplexity'),
      reasoningComplexityByToken
    ),
    riskLevel: normalizeStringEnum(field(record, 'riskLevel'), riskLevelByToken),
    executionMode: normalizeStringEnum(field(record, 'executionMode'), executionModeByToken),
    requiresTools: normalizeBoolean(field(record, 'requiresTools')),
    confidence: normalizeConfidence(field(record, 'confidence')),
  };
}

function field(record: Record<string, unknown>, key: string): unknown {
  return record[key] ?? record[toSnakeCase(key)];
}

function unwrapClassifierRecord(parsed: unknown): Record<string, unknown> | null {
  const record = asRecord(parsed);
  if (!record) return null;

  for (const wrapperKey of ['classification', 'result', 'output']) {
    const wrapper = asRecord(record[wrapperKey]);
    if (wrapper) return wrapper;
  }

  return record;
}

function repairSubtaskType(taskType: string | undefined, subtaskType: string | undefined) {
  if (!taskType) return subtaskType;
  const allowedSubtypes = subtypesByTaskType.get(taskType) ?? [];
  if (subtaskType && allowedSubtypes.includes(subtaskType)) return subtaskType;
  return defaultSubtaskByTaskType.get(taskType);
}

function normalizeConfidence(value: unknown): unknown {
  const record = asRecord(value);
  if (record) {
    for (const key of ['confidence', 'score', 'value', 'level', 'label', 'rating']) {
      if (key in record) return normalizeConfidence(record[key]);
    }
  }

  if (Array.isArray(value) && value.length === 1) {
    return normalizeConfidence(value[0]);
  }

  if (typeof value === 'number') {
    return value > 1 && value <= 100 ? value / 100 : value;
  }

  if (typeof value !== 'string') return value;
  const label = value.trim().toLowerCase();
  const numericText = label.endsWith('%') ? label.slice(0, -1).trim() : label;
  const numericMatch = numericText.match(/[0-9]+(?:\.[0-9]+)?/);
  const numericValue = Number(numericMatch?.[0] ?? numericText);
  if (Number.isFinite(numericValue)) {
    return numericValue > 1 && numericValue <= 100 ? numericValue / 100 : numericValue;
  }

  if (label.includes('very high')) return 0.95;
  if (label.includes('high')) return 0.85;
  if (label.includes('medium') || label.includes('moderate')) return 0.6;
  if (label.includes('low')) return 0.35;
  return value;
}

function normalizeBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return value;
}

function normalizeStringEnum(value: unknown, valuesByToken: Map<string, string>) {
  return typeof value === 'string' ? valuesByToken.get(token(value)) : undefined;
}

function enumMap(values: string[]) {
  return new Map(values.map(value => [token(value), value]));
}

function token(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function toSnakeCase(value: string) {
  return value.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function stripFence(text: string): string | null {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? null;
}

function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
