import { ClassifierOutputSchema, type ClassifierOutput } from '@kilocode/auto-routing-contracts';

export const classifierOutputSchema = ClassifierOutputSchema;
export type { ClassifierOutput };

export type ClassifierOutputParseFailureStage = 'invalid_json' | 'invalid_schema';

export class ClassifierOutputParseError extends Error {
  readonly failureStage: ClassifierOutputParseFailureStage;
  readonly outputLength: number;
  readonly schemaIssueSummary: string[];
  readonly topLevelKeys: string[];
  readonly fieldTypeSummary: string[];

  constructor(
    message: string,
    metadata: {
      failureStage: ClassifierOutputParseFailureStage;
      outputLength: number;
      schemaIssueSummary?: string[];
      topLevelKeys?: string[];
      fieldTypeSummary?: string[];
    }
  ) {
    super(message);
    this.name = 'ClassifierOutputParseError';
    this.failureStage = metadata.failureStage;
    this.outputLength = metadata.outputLength;
    this.schemaIssueSummary = metadata.schemaIssueSummary ?? [];
    this.topLevelKeys = metadata.topLevelKeys ?? [];
    this.fieldTypeSummary = metadata.fieldTypeSummary ?? [];
  }
}

const classifierOutputKeys = [
  'taskType',
  'subtaskType',
  'contextComplexity',
  'reasoningComplexity',
  'riskLevel',
  'executionMode',
  'requiresTools',
  'confidence',
] as const;

export function parseClassifierOutput(text: string): ClassifierOutput {
  const parsed = parseClassifierJson(text);
  const candidate = normalizeClassifierCandidate(parsed);
  const result = classifierOutputSchema.safeParse(candidate);
  if (!result.success) {
    throw new ClassifierOutputParseError('Classifier model returned invalid classification', {
      failureStage: 'invalid_schema',
      outputLength: text.length,
      schemaIssueSummary: result.error.issues.slice(0, 5).map(issue => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `${path}:${issue.code}`;
      }),
      topLevelKeys: topLevelKeys(candidate),
      fieldTypeSummary: fieldTypeSummary(candidate),
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
    outputLength: text.length,
  });
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
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
}

function normalizeClassifierCandidate(parsed: unknown): unknown {
  const object = asRecord(parsed);
  const classification = asRecord(object?.classification);
  const candidate = classification ?? object;
  if (!candidate) return parsed;

  const output: Record<string, unknown> = {};
  for (const key of classifierOutputKeys) {
    if (key in candidate) {
      output[key] = candidate[key];
    }
  }
  output.confidence = normalizeConfidence(output.confidence);
  return output;
}

function normalizeConfidence(value: unknown): unknown {
  const object = asRecord(value);
  if (object) {
    for (const key of ['confidence', 'score', 'value', 'level', 'label', 'rating']) {
      if (key in object) {
        return normalizeConfidence(object[key]);
      }
    }
  }
  if (Array.isArray(value) && value.length === 1) {
    return normalizeConfidence(value[0]);
  }
  if (typeof value === 'number') {
    return value > 1 && value <= 100 ? value / 100 : value;
  }
  if (typeof value !== 'string') return value;

  const trimmed = value.trim();
  const numericText = trimmed.endsWith('%') ? trimmed.slice(0, -1).trim() : trimmed;
  const numericMatch = numericText.match(/[0-9]+(?:\.[0-9]+)?/);
  const numericValue = Number(numericMatch?.[0] ?? numericText);
  if (!Number.isFinite(numericValue)) {
    const label = trimmed.toLowerCase();
    if (label.includes('very high')) return 0.95;
    if (label.includes('high')) return 0.85;
    if (label.includes('medium') || label.includes('moderate')) return 0.6;
    if (label.includes('low')) return 0.35;
    return value;
  }

  return numericValue > 1 && numericValue <= 100 ? numericValue / 100 : numericValue;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function topLevelKeys(value: unknown): string[] {
  return Object.keys(asRecord(value) ?? {}).slice(0, 20);
}

function fieldTypeSummary(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];
  return classifierOutputKeys
    .filter(key => key in record)
    .map(key => `${key}:${valueType(record[key])}`);
}

function valueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
