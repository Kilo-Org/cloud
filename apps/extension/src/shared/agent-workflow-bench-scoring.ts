/* eslint-disable max-lines -- Pinned harness decision contract: stored-workflow predicates, result classification, correlation, and batch aggregation read best as one cohesive module. */
/**
 * Pure, dependency-free harness decision logic for the workflow-create
 * benchmark. Consumes only the driver's validated minimal shapes
 * (`BenchWorkflow` / `BenchEvent`), never raw storage values. Predicate
 * details carry booleans and short match summaries only; no page, result,
 * script, or user content enters the output.
 */

export const TARGET_SCOPE_ORIGIN = 'https://www.google.com';
export const TARGET_PATH_PREFIX = '/travel/flights';
export const BENCH_SPEED_LIMIT_SECONDS = 180;

// Pinned scenario regexes (probe `live-workflow-probe.ts`).
const DESTINATION_PARAM_RE = /destination|city|to\b|arrival|where/iu;
const DATE_PARAM_RE = /date|day|when|time|departure/iu;
const BUSINESS_RE = /business/iu;
const ONE_WAY_RE = /one[\s-]?way/iu;
const PRICE_RE = /(?:€|\$|USD|EUR)/iu;
const CARRIER_WORD_RE =
  /(?:airlines|airways|air serbia|airserbia|air france|lufthansa|fly|flynas)\b/iu;
const CARRIER_CODE_RE = /[A-Z]{2}\s?\d{2,4}/u;
const ISO_DATE_RE = /^20\d\d-\d\d-\d\d$/u;
const DATE_SELECTOR_RE = /date|depart|when/iu;

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
  readonly id: string;
  readonly name: string;
  readonly type: 'tool-call';
}

export interface BenchToolResultEvent {
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

export interface BenchFollowUp {
  readonly date: string;
  readonly destination: string;
}

export interface BenchPredicate {
  readonly detail: string;
  readonly pass: boolean;
}

export type BenchResultCheck = 'real' | 'dry-run' | 'none';

export interface BenchCorrectnessInput {
  readonly events: readonly BenchEvent[];
  readonly followUp?: BenchFollowUp | undefined;
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
 * Correlation of every tool-result to its tool-call by `toolCallId`. A
 * tool-result that matches no tool-call is preserved as an explicit
 * `unknown-tool` classification in `unknownToolResults`; it never becomes a
 * named exchange, so it can never be read as a workflow run result.
 */
export interface BenchToolCorrelation {
  readonly exchanges: readonly BenchToolExchange[];
  readonly unknownToolResults: readonly BenchToolResultEvent[];
}

interface DryRunAction {
  readonly action: string;
  readonly selector: string;
}

interface RealRunChecks {
  readonly hasCarrier: boolean;
  readonly hasDate: boolean;
  readonly hasDestination: boolean;
  readonly hasPrice: boolean;
}

interface ExpectedValues {
  readonly date: string;
  readonly destination: string;
}

interface ResultOutcome {
  readonly extraPredicates: Record<string, BenchPredicate>;
  readonly resultCheck: BenchResultCheck;
  readonly resultDetail: string;
  readonly resultPass: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const findStringValues = (value: unknown, output: string[] = []): string[] => {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      findStringValues(entry, output);
    }
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      findStringValues(entry, output);
    }
  }

  return output;
};

/**
 * Correlate every tool-result with its tool-call by `toolCallId`
 * (`agent-conversation.ts` tool-result events carry no tool name). A
 * tool-result that matches no tool-call is preserved as an explicit
 * `unknown-tool` classification: it never becomes a named exchange, so it
 * can never be read as a workflow run result.
 */
export const correlateToolExchanges = (events: readonly BenchEvent[]): BenchToolCorrelation => {
  const exchanges: BenchToolExchange[] = [];
  const unknownToolResults: BenchToolResultEvent[] = [];

  for (const event of events) {
    if (event.type === 'tool-result') {
      const call = events.find(
        (candidate): candidate is BenchToolCallEvent =>
          candidate.type === 'tool-call' && candidate.id === event.toolCallId
      );

      if (call === undefined) {
        unknownToolResults.push(event);
      } else {
        exchanges.push({ call, result: event });
      }
    }
  }

  return { exchanges, unknownToolResults };
};

const hasNonEmptyInput = (input: unknown): boolean =>
  isRecord(input) && Object.keys(input).length > 0;

const selectLastValidRealRun = (
  exchanges: readonly BenchToolExchange[]
): BenchToolExchange | undefined => {
  const candidates = exchanges.filter(exchange => {
    const toolArguments = exchange.call.arguments;
    return (
      exchange.call.name === 'run_workflow' &&
      toolArguments['dryRun'] !== true &&
      hasNonEmptyInput(toolArguments['input']) &&
      exchange.result.ok
    );
  });

  return candidates.at(-1);
};

const selectLastDryRunCandidate = (
  exchanges: readonly BenchToolExchange[]
): BenchToolExchange | undefined => {
  const candidates = exchanges.filter(exchange => {
    const toolArguments = exchange.call.arguments;
    return (
      exchange.call.name === 'run_workflow' &&
      toolArguments['dryRun'] === true &&
      exchange.result.ok
    );
  });

  return candidates.at(-1);
};

const findDestinationParamName = (workflow: BenchWorkflow | undefined): string | undefined =>
  (workflow?.params ?? []).find(param =>
    DESTINATION_PARAM_RE.test(`${param.name} ${param.description ?? ''}`)
  )?.name;

const extractDestination = (
  workflow: BenchWorkflow | undefined,
  input: unknown,
  resultStrings: readonly string[]
): string | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }

  const paramName = findDestinationParamName(workflow);
  if (paramName !== undefined) {
    const value = input[paramName];
    if (typeof value === 'string' && value.trim() !== '') {
      return value;
    }
  }

  // Fallback: the input string value that appears in the result strings.
  // A date-looking or empty value can never be the destination.
  return findStringValues(input).find(value => {
    if (value.trim() === '' || ISO_DATE_RE.test(value)) {
      return false;
    }
    return resultStrings.some(candidate => candidate.toLowerCase().includes(value.toLowerCase()));
  });
};

const extractIsoDate = (input: unknown): string | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }

  return findStringValues(input).find(value => ISO_DATE_RE.test(value));
};

interface ExtractExpectedValuesInput {
  readonly dryRunCandidate: BenchToolExchange | undefined;
  readonly followUp: BenchFollowUp | undefined;
  readonly realRun: BenchToolExchange | undefined;
  readonly workflow: BenchWorkflow | undefined;
}

const extractExpectedValues = (input: ExtractExpectedValuesInput): ExpectedValues | undefined => {
  const { dryRunCandidate, followUp, realRun, workflow } = input;

  if (followUp === undefined) {
    const evidenceRun = realRun ?? dryRunCandidate;
    if (evidenceRun === undefined) {
      return undefined;
    }

    const resultStrings = findStringValues(evidenceRun.result.value);
    const destination = extractDestination(
      workflow,
      evidenceRun.call.arguments['input'],
      resultStrings
    );
    const date = extractIsoDate(evidenceRun.call.arguments['input']);

    if (destination === undefined || date === undefined) {
      return undefined;
    }

    return { date, destination };
  }

  return { date: followUp.date, destination: followUp.destination };
};

const checkRealRunResult = (
  strings: readonly string[],
  destination: string,
  date: string
): RealRunChecks => {
  const lowerDestination = destination.toLowerCase();
  const hasDestination = strings.some(value => value.toLowerCase().includes(lowerDestination));
  const hasDate = strings.some(value => value.includes(date));
  const hasPrice = strings.some(value => PRICE_RE.test(value) && /\d/iu.test(value));
  const hasCarrier = strings.some(
    value => CARRIER_WORD_RE.test(value) || CARRIER_CODE_RE.test(value)
  );

  return { hasCarrier, hasDate, hasDestination, hasPrice };
};

const checkDryRunInput = (input: unknown, destination: string, date: string): boolean => {
  const values = findStringValues(input);
  const lowerDestination = destination.toLowerCase();

  return values.some(value => value.toLowerCase() === lowerDestination) && values.includes(date);
};

const readDryRunActions = (value: unknown): readonly DryRunAction[] => {
  if (!isRecord(value)) {
    return [];
  }

  const raw = value['dryRunActions'];
  if (!Array.isArray(raw)) {
    return [];
  }

  const actions: DryRunAction[] = [];
  for (const entry of raw) {
    if (
      isRecord(entry) &&
      typeof entry['action'] === 'string' &&
      typeof entry['selector'] === 'string'
    ) {
      actions.push({ action: entry['action'], selector: entry['selector'] });
    }
  }

  return actions;
};

const checkDryRunActions = (actions: readonly DryRunAction[]): boolean => {
  const hasFill = actions.some(action => action.action === 'fill');
  const hasDateSelector = actions.some(action => DATE_SELECTOR_RE.test(action.selector));

  return actions.length >= 2 && hasFill && hasDateSelector;
};

const predicate = (pass: boolean, detail: string): BenchPredicate => ({ detail, pass });

const scoreStoredWorkflowPredicates = (
  workflow: BenchWorkflow | undefined
): Record<string, BenchPredicate> => {
  const workflowStored = workflow !== undefined;
  const scopeOriginMatched = workflow !== undefined && workflow.scopeOrigin === TARGET_SCOPE_ORIGIN;
  const pathPrefixMatched =
    workflow !== undefined && (workflow.pathPrefix ?? '') === TARGET_PATH_PREFIX;
  const approvedHashPresent =
    workflow !== undefined &&
    typeof workflow.approvedScriptHash === 'string' &&
    workflow.approvedScriptHash.length > 0;

  const params = workflow?.params ?? [];
  const destinationParam = params.find(param =>
    DESTINATION_PARAM_RE.test(`${param.name} ${param.description ?? ''}`)
  );
  const dateParam = params.find(param =>
    DATE_PARAM_RE.test(`${param.name} ${param.description ?? ''}`)
  );
  const paramsPresent = destinationParam !== undefined && dateParam !== undefined;

  const script = workflow?.script ?? '';
  const businessPresent = BUSINESS_RE.test(script);
  const oneWayPresent = ONE_WAY_RE.test(script);

  return {
    approvedScriptHash: predicate(
      approvedHashPresent,
      `approved script hash present: ${String(approvedHashPresent)}`
    ),
    pathPrefix: predicate(pathPrefixMatched, `path prefix matched: ${String(pathPrefixMatched)}`),
    scopeOrigin: predicate(
      scopeOriginMatched,
      `scope origin matched: ${String(scopeOriginMatched)}`
    ),
    scriptBusiness: predicate(
      businessPresent,
      `business marker present: ${String(businessPresent)}`
    ),
    scriptOneWay: predicate(oneWayPresent, `one-way marker present: ${String(oneWayPresent)}`),
    storedWorkflow: predicate(
      workflowStored,
      workflowStored ? 'workflow stored: true' : 'no workflow stored'
    ),
    workflowParams: predicate(
      paramsPresent,
      `destination and date params present: ${String(paramsPresent)}`
    ),
  };
};

const classifyResult = (
  expected: ExpectedValues | undefined,
  realRun: BenchToolExchange | undefined,
  dryRunCandidate: BenchToolExchange | undefined
): ResultOutcome => {
  if (expected === undefined) {
    return {
      extraPredicates: {},
      resultCheck: 'none',
      resultDetail: 'expected destination or date not found',
      resultPass: false,
    };
  }

  if (realRun !== undefined) {
    const strings = findStringValues(realRun.result.value);
    const checks = checkRealRunResult(strings, expected.destination, expected.date);
    const resultPass =
      checks.hasDestination && checks.hasDate && checks.hasPrice && checks.hasCarrier;

    return {
      extraPredicates: {
        resultHasCarrier: predicate(
          checks.hasCarrier,
          `carrier matched: ${String(checks.hasCarrier)}`
        ),
        resultHasDate: predicate(checks.hasDate, `date matched: ${String(checks.hasDate)}`),
        resultHasDestination: predicate(
          checks.hasDestination,
          `destination matched: ${String(checks.hasDestination)}`
        ),
        resultHasPrice: predicate(checks.hasPrice, `price matched: ${String(checks.hasPrice)}`),
      },
      resultCheck: 'real',
      resultDetail: [
        `destination: ${String(checks.hasDestination)}`,
        `date: ${String(checks.hasDate)}`,
        `price: ${String(checks.hasPrice)}`,
        `carrier: ${String(checks.hasCarrier)}`,
      ].join(', '),
      resultPass,
    };
  }

  if (dryRunCandidate !== undefined) {
    const inputBound = checkDryRunInput(
      dryRunCandidate.call.arguments['input'],
      expected.destination,
      expected.date
    );
    const actionsSufficient = checkDryRunActions(readDryRunActions(dryRunCandidate.result.value));

    return {
      extraPredicates: {
        dryRunActions: predicate(
          actionsSufficient,
          `dry-run actions sufficient: ${String(actionsSufficient)}`
        ),
        dryRunInput: predicate(
          inputBound,
          `destination and date in dry-run input: ${String(inputBound)}`
        ),
      },
      resultCheck: 'dry-run',
      resultDetail: `input: ${String(inputBound)}, actions: ${String(actionsSufficient)}`,
      resultPass: inputBound && actionsSufficient,
    };
  }

  return {
    extraPredicates: {},
    resultCheck: 'none',
    resultDetail: 'no valid real run or dry-run fallback',
    resultPass: false,
  };
};

/**
 * Score one benchmark attempt's correctness. The stored-workflow predicates
 * are pinned to the fixed scenario; the result check uses the last valid real
 * run (non-dry, non-empty input, ok result) or, when none exists, the
 * contract-level dry-run fallback (input binds the expected values and the
 * recorded actions show a fill plus a date-ish selector).
 */
export const scoreWorkflowCorrectness = (input: BenchCorrectnessInput): BenchCorrectnessResult => {
  const [workflow] = input.workflows;
  const predicates: Record<string, BenchPredicate> = scoreStoredWorkflowPredicates(workflow);

  const { exchanges } = correlateToolExchanges(input.events);
  const realRun = selectLastValidRealRun(exchanges);
  const dryRunCandidate = selectLastDryRunCandidate(exchanges);
  const expected = extractExpectedValues({
    dryRunCandidate,
    followUp: input.followUp,
    realRun,
    workflow,
  });

  const outcome = classifyResult(expected, realRun, dryRunCandidate);
  Object.assign(predicates, outcome.extraPredicates);
  predicates['runWorkflowResult'] = predicate(outcome.resultPass, outcome.resultDetail);

  const storedPassed =
    predicates['storedWorkflow']?.pass === true &&
    predicates['scopeOrigin']?.pass === true &&
    predicates['pathPrefix']?.pass === true &&
    predicates['approvedScriptHash']?.pass === true &&
    predicates['workflowParams']?.pass === true &&
    predicates['scriptBusiness']?.pass === true &&
    predicates['scriptOneWay']?.pass === true;

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
  const speedGatePassed = attempts.every(
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
