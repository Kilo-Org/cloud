/**
 * Pure decision logic for the use-case task benchmark. Consumes the driver's
 * validated event shapes plus a task scenario spec and scores the final
 * assistant answer: pinned content checks, a minimum length, tool-result
 * evidence for hallucination-prone facts, and — for action scenarios — at
 * least one ok eval exchange.
 */
import { computeBatchSummary, correlateToolExchanges } from './agent-workflow-bench-scoring';
import type {
  BenchAttemptStats,
  BenchBatchSummary,
  BenchEvent,
  BenchPredicate,
} from './agent-workflow-bench-scoring';
import type { BenchTaskScenario } from './agent-task-bench-scenarios';

/** Read-and-answer tasks are held to a tighter gate than workflow creation. */
export const TASK_SPEED_LIMIT_SECONDS = 120;

export interface BenchTaskCorrectnessResult {
  readonly passed: boolean;
  readonly predicates: Record<string, BenchPredicate>;
}

const predicate = (pass: boolean, detail: string): BenchPredicate => ({ detail, pass });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Harness metadata strings can accidentally satisfy an evidence pattern:
 * the snapshot paging note embeds character counts ("characters 16000-24000
 * of 233274" contains "3327") and snapshotId is base36 of a timestamp. Only
 * page-derived strings count as evidence.
 */
const NON_EVIDENCE_KEYS = new Set(['note', 'snapshotId']);

const collectStrings = (value: unknown, output: string[] = []): string[] => {
  if (typeof value === 'string') {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, output);
    }
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (!NON_EVIDENCE_KEYS.has(key)) {
        collectStrings(entry, output);
      }
    }
  }

  return output;
};

/** The answer is the last non-empty assistant message of the conversation. */
export const selectFinalAnswer = (events: readonly BenchEvent[]): string => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event !== undefined &&
      event.type === 'message' &&
      event.role === 'assistant' &&
      typeof event.text === 'string' &&
      event.text.trim() !== ''
    ) {
      return event.text;
    }
  }
  return '';
};

export const scoreTaskCorrectness = ({
  events,
  scenario,
}: {
  readonly events: readonly BenchEvent[];
  readonly scenario: BenchTaskScenario;
}): BenchTaskCorrectnessResult => {
  const answer = selectFinalAnswer(events);
  const { exchanges } = correlateToolExchanges(events);
  const okResultStrings = exchanges
    .filter(exchange => exchange.result.ok)
    .flatMap(exchange => collectStrings(exchange.result.value));

  const failedChecks = scenario.answerChecks
    .filter(check => !check.re.test(answer))
    .map(check => check.key);
  const missingEvidence = scenario.answerChecks
    .filter(
      check =>
        check.requireToolEvidence === true && !okResultStrings.some(entry => check.re.test(entry))
    )
    .map(check => check.key);

  const lengthOk = answer.length >= scenario.minAnswerChars;
  const actionOk =
    !scenario.requiresAction ||
    exchanges.some(exchange => exchange.call.name === 'eval' && exchange.result.ok);

  const predicates: Record<string, BenchPredicate> = {
    actionPerformed: predicate(
      actionOk,
      scenario.requiresAction
        ? `ok eval exchange present: ${String(actionOk)}`
        : 'no action required'
    ),
    answerContent: predicate(
      failedChecks.length === 0,
      failedChecks.length === 0
        ? 'answer content checks passed'
        : `answer content checks failed: ${failedChecks.join(', ')}`
    ),
    answerLength: predicate(
      lengthOk,
      `answer length ${String(answer.length)} >= ${String(scenario.minAnswerChars)}: ${String(lengthOk)}`
    ),
    toolEvidence: predicate(
      missingEvidence.length === 0,
      missingEvidence.length === 0
        ? 'evidence-flagged checks found in ok tool results'
        : `tool evidence missing: ${missingEvidence.join(', ')}`
    ),
  };

  return {
    passed: failedChecks.length === 0 && missingEvidence.length === 0 && lengthOk && actionOk,
    predicates,
  };
};

/**
 * Task batches reuse the workflow batch aggregation, but the speed gate runs
 * on turn totals: every attempt's turn must finish inside the task limit.
 */
export const computeTaskBatchSummary = (
  attempts: readonly BenchAttemptStats[]
): BenchBatchSummary => {
  const base = computeBatchSummary(attempts);
  const speedGatePassed =
    attempts.length > 0 &&
    attempts.every(
      attempt =>
        attempt.turnTotalSeconds !== null && attempt.turnTotalSeconds < TASK_SPEED_LIMIT_SECONDS
    );
  return { ...base, speedGatePassed };
};
