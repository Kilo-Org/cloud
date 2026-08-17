/* eslint-disable max-lines -- Pinned harness decision contract: stored-workflow predicates, run-evidence scoring, correlation, and batch aggregation read best as one cohesive module. */
/**
 * Pure harness decision logic for the workflow-create benchmark. Consumes
 * only the driver's validated minimal shapes (`BenchWorkflow` / `BenchEvent`)
 * plus a scenario spec, never raw storage values. Predicate details carry
 * booleans and short match summaries only; no page, result, script, or user
 * content enters the output.
 */
import { ISO_DATE_RE, isoDateVariants } from './agent-workflow-bench-scenarios';
import type { BenchScenario } from './agent-workflow-bench-scenarios';
import { coerceWorkflowRunInput } from './agent-workflow-runner';
import { hashWorkflowScript, matchesWorkflowScope } from './agent-workflows';

export const BENCH_SPEED_LIMIT_SECONDS = 180;

export interface BenchWorkflowParam {
  readonly description?: string | undefined;
  readonly name: string;
}

export interface BenchWorkflow {
  readonly approvedScriptHash?: string | undefined;
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly params?: BenchWorkflowParam[] | undefined;
  readonly pathPrefix?: string | undefined;
  readonly scopeOrigin: string;
  readonly script: string;
}

export interface BenchToolCallEvent {
  readonly arguments: Record<string, unknown>;
  /** Eval tool calls carry code instead of arguments; redaction reports only its length. */
  readonly code?: string;
  readonly id: string;
  readonly name: string;
  readonly type: 'tool-call';
}

export interface BenchToolResultEvent {
  /** The tool failure text; used by the driver's metrics and redaction. */
  readonly error?: string;
  readonly id: string;
  readonly ok: boolean;
  readonly toolCallId: string;
  readonly type: 'tool-result';
  readonly value?: unknown;
}

/**
 * Validated conversation events. Non-tool events are accepted so the driver
 * can pass its full validated event list, but only tool-call and tool-result
 * events participate in scoring.
 */
export type BenchEvent =
  | {
      readonly id: string;
      readonly role?: string;
      readonly text?: string;
      readonly type: 'message';
    }
  | {
      readonly id: string;
      readonly text?: string;
      readonly type: 'thinking';
    }
  | BenchToolCallEvent
  | BenchToolResultEvent;

export interface BenchPredicate {
  readonly detail: string;
  readonly pass: boolean;
}

export type BenchResultCheck = 'real' | 'dry-run' | 'none';

export interface BenchCorrectnessInput {
  readonly events: readonly BenchEvent[];
  /** Resolved follow-up values ({date} already substituted); undefined when no follow-up was sent. */
  readonly followUpValues?: Readonly<Record<string, string>> | undefined;
  readonly scenario: BenchScenario;
  readonly workflows: readonly BenchWorkflow[];
}

export interface BenchCorrectnessResult {
  readonly passed: boolean;
  readonly predicates: Record<string, BenchPredicate>;
  readonly resultCheck: BenchResultCheck;
}

export interface BenchAttemptStats {
  readonly createToSavedSeconds: number | null;
  readonly llmCreateRequestCount: number;
  readonly llmRequestCount: number;
  readonly readCallsBeforeFirstSave: number;
  readonly success: boolean;
  readonly toolCallCount: number;
  readonly toolErrorCount: number;
  readonly turnTotalSeconds: number | null;
}

export interface BenchSummaryMedians {
  readonly createToSavedSeconds: number | null;
  readonly llmCreateRequestCount: number | null;
  readonly llmRequestCount: number | null;
  readonly readCallsBeforeFirstSave: number | null;
  readonly toolCallCount: number | null;
  readonly toolErrorCount: number | null;
  readonly turnTotalSeconds: number | null;
}

export interface BenchBatchSummary {
  readonly attempts: number;
  readonly maxCreateToSavedSeconds: number | null;
  readonly medians: BenchSummaryMedians;
  readonly speedGatePassed: boolean;
  readonly successCount: number;
}

export interface BenchToolExchange {
  readonly call: BenchToolCallEvent;
  readonly result: BenchToolResultEvent;
}

/**
 * Correlation of every tool-result to its tool-call by `toolCallId`.
 * A tool-result that matches no tool-call is omitted from named exchanges,
 * so it can never be read as a workflow run result.
 */
export interface BenchToolCorrelation {
  readonly exchanges: readonly BenchToolExchange[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Collect every string, number, and boolean leaf of a JSON-ish value as text.
 * A numeric eval result (`{ ok: true, value: 6 }`) is evidence like the string
 * form. `excludeKeys` skips record entries under those keys (harness metadata
 * that must not count as evidence).
 */
export const findStringValues = (value: unknown, excludeKeys?: ReadonlySet<string>): string[] => {
  const output: string[] = [];
  const walk = (entry: unknown): void => {
    if (typeof entry === 'string') {
      output.push(entry);
    } else if (typeof entry === 'number' || typeof entry === 'boolean') {
      output.push(String(entry));
    } else if (Array.isArray(entry)) {
      for (const item of entry) {
        walk(item);
      }
    } else if (isRecord(entry)) {
      for (const [key, item] of Object.entries(entry)) {
        if (excludeKeys === undefined || !excludeKeys.has(key)) {
          walk(item);
        }
      }
    }
  };
  walk(value);
  return output;
};

/**
 * Correlate every tool-result with its tool-call by `toolCallId`
 * (`agent-conversation.ts` tool-result events carry no tool name).
 */
export const correlateToolExchanges = (events: readonly BenchEvent[]): BenchToolCorrelation => {
  const exchanges: BenchToolExchange[] = [];

  for (const event of events) {
    if (event.type === 'tool-result') {
      const call = events.find(
        (candidate): candidate is BenchToolCallEvent =>
          candidate.type === 'tool-call' && candidate.id === event.toolCallId
      );

      if (call !== undefined) {
        exchanges.push({ call, result: event });
      }
    }
  }

  return { exchanges };
};

// The runner coerces string inputs (string-encoded JSON, chat-template arg pairs) before running; the scorer must read the input the run actually used, not the raw argument.
const hasNonEmptyInput = (input: unknown): boolean => {
  const coerced = coerceWorkflowRunInput(input);
  return isRecord(coerced) && Object.keys(coerced).length > 0;
};

/**
 * The verifying run must carry an input when the scenario pins follow-up
 * values; a zero-param scenario ("get today's headlines") legitimately runs
 * with no input at all.
 */
export const selectLastValidRun = (
  exchanges: readonly BenchToolExchange[],
  {
    dryRun = false,
    requireInput = true,
  }: { readonly dryRun?: boolean; readonly requireInput?: boolean } = {}
): BenchToolExchange | undefined => {
  const candidates = exchanges.filter(exchange => {
    const toolArguments = exchange.call.arguments;
    return (
      exchange.call.name === 'run_workflow' &&
      (toolArguments['dryRun'] === true) === dryRun &&
      (!requireInput || hasNonEmptyInput(toolArguments['input'])) &&
      exchange.result.ok
    );
  });

  return candidates.at(-1);
};

const predicate = (pass: boolean, detail: string): BenchPredicate => ({ detail, pass });

const scoreStoredWorkflowPredicates = async (
  scenario: BenchScenario,
  workflow: BenchWorkflow | undefined
): Promise<Record<string, BenchPredicate>> => {
  const workflowStored = workflow !== undefined;
  const scopeOriginMatched =
    workflow !== undefined && workflow.scopeOrigin === scenario.scopeOrigin;
  const scopeCoversStart =
    workflow !== undefined && matchesWorkflowScope(workflow, scenario.startUrl);
  const approvedHashValid =
    workflow !== undefined &&
    typeof workflow.approvedScriptHash === 'string' &&
    workflow.approvedScriptHash === (await hashWorkflowScript(workflow.script));

  const params = workflow?.params ?? [];
  const missingParams = scenario.expectedParams
    .filter(
      expected =>
        !params.some(param => expected.re.test(`${param.name} ${param.description ?? ''}`))
    )
    .map(expected => expected.key);

  const script = workflow?.script ?? '';
  const missingMarkers = scenario.scriptMarkers
    .filter(marker => !marker.re.test(script))
    .map(marker => marker.key);

  return {
    approvedScriptHash: predicate(
      approvedHashValid,
      `approved script hash matches the stored script: ${String(approvedHashValid)}`
    ),
    scopeCoversStartUrl: predicate(
      scopeCoversStart,
      `workflow scope covers the start URL: ${String(scopeCoversStart)}`
    ),
    scopeOrigin: predicate(
      scopeOriginMatched,
      `scope origin matched: ${String(scopeOriginMatched)}`
    ),
    scriptMarkers: predicate(
      missingMarkers.length === 0,
      missingMarkers.length === 0
        ? 'script markers present'
        : `script markers missing: ${missingMarkers.join(', ')}`
    ),
    storedWorkflow: predicate(
      workflowStored,
      workflowStored ? 'workflow stored: true' : 'no workflow stored'
    ),
    workflowParams: predicate(
      missingParams.length === 0,
      missingParams.length === 0
        ? 'expected params declared'
        : `params missing: ${missingParams.join(', ')}`
    ),
  };
};

/**
 * Case-insensitive, word-boundary containment of `value` in the strings.
 * An ISO date matches when any human variant appears as a substring. Every
 * other value matches when each of its tokens appears as a whole word — a
 * pinned "go" never matches "Django" or "ago", and a multi-part value
 * (e.g. "microsoft/vscode") still matches across separators or when models
 * split it into separate params.
 */
const stringsContainValue = (strings: readonly string[], value: string): boolean => {
  if (ISO_DATE_RE.test(value)) {
    const variants = isoDateVariants(value).map(variant => variant.toLowerCase());
    return strings.some(entry => {
      const lower = entry.toLowerCase();
      return variants.some(variant => lower.includes(variant));
    });
  }
  const haystack = ` ${strings
    .join(' ')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, ' ')} `;
  const tokens = value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return tokens.length > 0 && tokens.every(token => haystack.includes(` ${token} `));
};

interface RunOutcome {
  readonly extraPredicates: Record<string, BenchPredicate>;
  readonly resultCheck: BenchResultCheck;
  readonly resultPass: boolean;
}

const scoreEvidenceRun = ({
  evidence,
  followUpValues,
  resultCheck,
  scenario,
}: {
  readonly evidence: BenchToolExchange;
  readonly followUpValues: Readonly<Record<string, string>>;
  readonly resultCheck: Exclude<BenchResultCheck, 'none'>;
  readonly scenario: BenchScenario;
}): RunOutcome => {
  const inputStrings = findStringValues(coerceWorkflowRunInput(evidence.call.arguments['input']));
  const missingInput = Object.entries(followUpValues)
    .filter(([, value]) =>
      ISO_DATE_RE.test(value)
        ? !inputStrings.includes(value)
        : !stringsContainValue(inputStrings, value)
    )
    .map(([key]) => key);

  const resultStrings = findStringValues(evidence.result.value);
  const resultLength = resultStrings.join(' ').length;

  const missingValues = scenario.resultMustContainValues.filter(key => {
    const value = followUpValues[key];
    return value === undefined || !stringsContainValue(resultStrings, value);
  });

  const failedContent = scenario.resultContentChecks
    .filter(check => !resultStrings.some(entry => check.re.test(entry)))
    .map(check => check.key);

  const lengthOk = resultLength >= scenario.minResultChars;

  const extraPredicates: Record<string, BenchPredicate> = {
    resultContent: predicate(
      failedContent.length === 0,
      failedContent.length === 0
        ? 'result content checks passed'
        : `result content checks failed: ${failedContent.join(', ')}`
    ),
    resultHasValues: predicate(
      missingValues.length === 0,
      missingValues.length === 0
        ? 'follow-up values present in result'
        : `values missing from result: ${missingValues.join(', ')}`
    ),
    resultLength: predicate(
      lengthOk,
      `result length ${String(resultLength)} >= ${String(scenario.minResultChars)}: ${String(lengthOk)}`
    ),
    runInputBound: predicate(
      missingInput.length === 0,
      missingInput.length === 0
        ? 'follow-up values present in run input'
        : `values missing from run input: ${missingInput.join(', ')}`
    ),
  };

  return {
    extraPredicates,
    resultCheck,
    resultPass:
      missingInput.length === 0 &&
      missingValues.length === 0 &&
      failedContent.length === 0 &&
      lengthOk,
  };
};

/**
 * Score one benchmark attempt's correctness against its scenario spec.
 * The verifying run is the last valid real run (non-dry, non-empty input, ok
 * result) or, when none exists, the last ok dry run with a non-empty input —
 * a URL-first script's dry run navigates and reads for real, so its result is
 * held to the same content checks.
 */
export const scoreWorkflowCorrectness = async (
  input: BenchCorrectnessInput
): Promise<BenchCorrectnessResult> => {
  const { scenario } = input;
  const { exchanges } = correlateToolExchanges(input.events);
  const requireInput = Object.keys(input.followUpValues ?? {}).length > 0;
  const evidenceReal = selectLastValidRun(exchanges, { requireInput });
  const evidenceDry =
    evidenceReal === undefined
      ? selectLastValidRun(exchanges, { dryRun: true, requireInput })
      : undefined;

  /**
   * Score the stored workflow the verifying run actually targeted. Without a
   * valid run (dry-run-only with no id, or no run at all), fall back to the
   * newest saved workflow, never the oldest.
   */
  const boundWorkflowId = (evidenceReal ?? evidenceDry)?.call.arguments['workflowId'];
  const workflow =
    (typeof boundWorkflowId === 'string'
      ? input.workflows.find(candidate => candidate.id === boundWorkflowId)
      : undefined) ?? input.workflows.at(-1);
  const predicates: Record<string, BenchPredicate> = await scoreStoredWorkflowPredicates(
    scenario,
    workflow
  );

  const resolveOutcome = (): { outcome: RunOutcome; runPredicate: BenchPredicate } => {
    const noRun = (detail: string): { outcome: RunOutcome; runPredicate: BenchPredicate } => ({
      outcome: { extraPredicates: {}, resultCheck: 'none', resultPass: false },
      runPredicate: predicate(false, detail),
    });
    if (input.followUpValues === undefined) {
      return noRun('no follow-up values to verify against');
    }
    if (evidenceReal !== undefined) {
      const outcome = scoreEvidenceRun({
        evidence: evidenceReal,
        followUpValues: input.followUpValues,
        resultCheck: 'real',
        scenario,
      });
      return {
        outcome,
        runPredicate: predicate(
          outcome.resultPass,
          `real run verified: ${String(outcome.resultPass)}`
        ),
      };
    }
    if (evidenceDry !== undefined) {
      const outcome = scoreEvidenceRun({
        evidence: evidenceDry,
        followUpValues: input.followUpValues,
        resultCheck: 'dry-run',
        scenario,
      });
      return {
        outcome,
        runPredicate: predicate(
          outcome.resultPass,
          `dry run verified: ${String(outcome.resultPass)}`
        ),
      };
    }
    return noRun('no valid run with input found');
  };

  const { outcome, runPredicate } = resolveOutcome();
  Object.assign(predicates, outcome.extraPredicates);
  predicates['runWorkflowResult'] = runPredicate;

  const storedPassed =
    predicates['storedWorkflow']?.pass === true &&
    predicates['scopeOrigin']?.pass === true &&
    predicates['scopeCoversStartUrl']?.pass === true &&
    predicates['approvedScriptHash']?.pass === true &&
    predicates['workflowParams']?.pass === true &&
    predicates['scriptMarkers']?.pass === true;

  return {
    passed: storedPassed && outcome.resultPass,
    predicates,
    resultCheck: outcome.resultCheck,
  };
};

const median = (samples: readonly number[]): number | null => {
  if (samples.length === 0) {
    return null;
  }

  const sorted = samples.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }

  const [lower, upper] = sorted.slice(middle - 1, middle + 1);
  if (lower === undefined || upper === undefined) {
    return null;
  }

  return (lower + upper) / 2;
};

/**
 * Aggregate a batch of attempt stats. Medians and the max run over attempts
 * where the metric is non-null; a metric with no non-null samples reports
 * `null`. The 180 s speed gate is a summary-level signal only; it never
 * changes an attempt's success flag.
 */
export const computeBatchSummary = (attempts: readonly BenchAttemptStats[]): BenchBatchSummary => {
  const nonNull = (select: (attempt: BenchAttemptStats) => number | null): number[] => {
    const values: number[] = [];
    for (const attempt of attempts) {
      const value = select(attempt);
      if (value !== null) {
        values.push(value);
      }
    }
    return values;
  };

  const createTimes = nonNull(attempt => attempt.createToSavedSeconds);

  const medians: BenchSummaryMedians = {
    createToSavedSeconds: median(createTimes),
    llmCreateRequestCount: median(nonNull(attempt => attempt.llmCreateRequestCount)),
    llmRequestCount: median(nonNull(attempt => attempt.llmRequestCount)),
    readCallsBeforeFirstSave: median(nonNull(attempt => attempt.readCallsBeforeFirstSave)),
    toolCallCount: median(nonNull(attempt => attempt.toolCallCount)),
    toolErrorCount: median(nonNull(attempt => attempt.toolErrorCount)),
    turnTotalSeconds: median(nonNull(attempt => attempt.turnTotalSeconds)),
  };

  const successCount = attempts.filter(attempt => attempt.success).length;
  const maxCreateToSavedSeconds = createTimes.length === 0 ? null : Math.max(...createTimes);
  const speedGatePassed =
    attempts.length > 0 &&
    attempts.every(
      attempt =>
        attempt.createToSavedSeconds !== null &&
        attempt.createToSavedSeconds < BENCH_SPEED_LIMIT_SECONDS
    );

  return {
    attempts: attempts.length,
    maxCreateToSavedSeconds,
    medians,
    speedGatePassed,
    successCount,
  };
};
