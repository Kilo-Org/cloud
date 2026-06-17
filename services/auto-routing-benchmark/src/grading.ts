import type { ClassifierOutput } from '@kilocode/auto-routing-contracts';

// Golden labels grade every classifier field except confidence. subtaskType
// is worth less than taskType: a wrong subtype under the right type is a near
// miss. riskLevel gets a small weight because it is a secondary routing signal.
export type ClassifierExpectation = {
  taskType: ClassifierOutput['taskType'];
  subtaskType: ClassifierOutput['subtaskType'];
  contextComplexity: ClassifierOutput['contextComplexity'];
  reasoningComplexity: ClassifierOutput['reasoningComplexity'];
  riskLevel: ClassifierOutput['riskLevel'];
  executionMode: ClassifierOutput['executionMode'];
  requiresTools: boolean;
};

export const CLASSIFIER_FIELD_WEIGHTS: Record<keyof ClassifierExpectation, number> = {
  taskType: 0.25,
  subtaskType: 0.1,
  reasoningComplexity: 0.2,
  contextComplexity: 0.15,
  executionMode: 0.15,
  riskLevel: 0.05,
  requiresTools: 0.1,
};

export function gradeClassifierOutput(
  expected: ClassifierExpectation,
  actual: ClassifierOutput
): number {
  let score = 0;
  for (const key of Object.keys(CLASSIFIER_FIELD_WEIGHTS) as (keyof ClassifierExpectation)[]) {
    if (actual[key] === expected[key]) score += CLASSIFIER_FIELD_WEIGHTS[key];
  }
  return Number(score.toFixed(4));
}

export type DeciderCheck =
  | { kind: 'exact'; value: string }
  | { kind: 'contains_all'; values: readonly string[] }
  | { kind: 'regex'; pattern: string; flags?: string }
  | { kind: 'json_equal'; value: unknown };

// Mechanical pass/fail grading keeps the decider benchmark deterministic:
// no LLM judges. Normalization tolerates formatting noise (whitespace,
// case, markdown fences) without weakening the assertion.
export function normalizeAnswer(text: string): string {
  return text
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/```/g, '')
    .trim()
    .toLowerCase();
}

// Balance-scan from the first `{`/`[` to its matching close so trailing prose
// after the JSON payload doesn't break parsing. String-aware so braces inside
// string literals are ignored.
function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?\n?/gi, '').replace(/```/g, '');
  const start = stripped.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found');

  const open = stripped[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return JSON.parse(stripped.slice(start, i + 1));
      }
    }
  }
  throw new Error('unbalanced JSON');
}

export function runDeciderCheck(check: DeciderCheck, output: string): boolean {
  switch (check.kind) {
    case 'exact': {
      // Agent harnesses sometimes prepend prose despite instructions; accept
      // the answer when the whole output OR its last non-empty line matches.
      // Wrong answers fail either way.
      const normalized = normalizeAnswer(output);
      const expected = normalizeAnswer(check.value);
      if (normalized === expected) return true;
      const lastLine =
        normalized
          .split('\n')
          .filter(l => l.trim().length > 0)
          .at(-1) ?? '';
      return lastLine.trim() === expected;
    }
    case 'contains_all':
      return check.values.every(v => normalizeAnswer(output).includes(normalizeAnswer(v)));
    case 'regex':
      return new RegExp(check.pattern, check.flags).test(output);
    case 'json_equal': {
      try {
        return JSON.stringify(extractJson(output)) === JSON.stringify(check.value);
      } catch {
        return false;
      }
    }
  }
}
