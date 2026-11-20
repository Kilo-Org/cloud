import type { AutoRouter } from '@kilocode/auto-routing-contracts';
import { CONTINUATION_CASES } from './datasets/continuation-cases';
import { DECIDER_CASES, FRONTIER_CASES, type DeciderCase } from './datasets/decider-cases';
import type { DeciderCheck } from './grading';
import { argvAffectedCases, PROMPT_TRANSPORT_REVISION } from './prompt-transport';

/**
 * Revision of the decider cases and grading a run measures. Every run records the revision it
 * started under and keeps it to the end, and every case result records the revision that
 * measured it (`prompt_revision`), so one run never mixes two gradings of a case.
 *
 * 1. Prompt passed as an argv positional (see prompt-transport.ts).
 * 2. Prompt on stdin, long-context cases with their snapshot.
 * 3. Efficient agentic cases score 0 without a tool call, continuation cases resume a session
 *    in progress, and supp-agent-term-pwd-base accepts only its true answer.
 *
 * The engine identity hashes the revision-2 cases. A later revision keeps that identity, so
 * every result it does not change stays reusable; {@link minimumCaseRevisions} names the
 * results it does change.
 */
export const MEASUREMENT_REVISION = 3;

export const ENGINE_IDENTITY_REVISION = PROMPT_TRANSPORT_REVISION;

// A client upload carries only the final text and runs a plain prompt, so client evals can
// grade neither tool evidence nor a continuation.
export const CLIENT_EVAL_REVISION = PROMPT_TRANSPORT_REVISION;

const TOOL_EVIDENCE_REVISION = 3;

// The container runs each case in a fresh temp directory, so pwd never ends with /app.
const PWD_BASE_CASE_ID = 'supp-agent-term-pwd-base';
const PWD_BASE_CHECK: DeciderCheck = { kind: 'exact', value: 'other' };

function withToolEvidence(benchCase: DeciderCase): DeciderCase {
  if (benchCase.taskType !== 'agentic_execution') return benchCase;
  return {
    ...benchCase,
    requiredToolCalls: 1,
    ...(benchCase.id === PWD_BASE_CASE_ID ? { check: PWD_BASE_CHECK } : {}),
  };
}

const EFFICIENT_TOOL_EVIDENCE_CASES: readonly DeciderCase[] = [
  ...DECIDER_CASES.map(withToolEvidence),
  ...CONTINUATION_CASES,
];

const TOOL_EVIDENCE_CASE_IDS = EFFICIENT_TOOL_EVIDENCE_CASES.filter(
  benchCase => benchCase.taskType === 'agentic_execution'
).map(benchCase => benchCase.id);

export function deciderCasesForRouter(
  router: AutoRouter,
  revision: number
): readonly DeciderCase[] {
  if (router === 'frontier') return FRONTIER_CASES;
  return revision >= TOOL_EVIDENCE_REVISION ? EFFICIENT_TOOL_EVIDENCE_CASES : DECIDER_CASES;
}

/**
 * The oldest result revision a run of `revision` may still reuse, per case; cases absent from
 * the map accept any revision. A result below its case's minimum runs again.
 */
export function minimumCaseRevisions(
  router: AutoRouter,
  revision: number,
  options: { frontierInnerQuotes?: boolean } = {}
): Record<string, number> {
  const minimums: Record<string, number> = {};
  for (const benchCase of argvAffectedCases(router, options)) {
    minimums[benchCase.id] = PROMPT_TRANSPORT_REVISION;
  }
  if (router === 'efficient' && revision >= TOOL_EVIDENCE_REVISION) {
    for (const caseId of TOOL_EVIDENCE_CASE_IDS) minimums[caseId] = TOOL_EVIDENCE_REVISION;
  }
  return minimums;
}

/**
 * The grading a run of `revision` applies to the router's cases, named by the revision that
 * introduced it. Two runs with equal grading revisions are comparable on every route.
 */
export function gradingRevision(router: AutoRouter, revision: number): number {
  return router === 'efficient' && revision >= TOOL_EVIDENCE_REVISION
    ? TOOL_EVIDENCE_REVISION
    : ENGINE_IDENTITY_REVISION;
}
