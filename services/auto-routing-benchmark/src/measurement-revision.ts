import type { AutoRouter } from '@kilocode/auto-routing-contracts';
import { DECIDER_CASES, FRONTIER_CASES, type DeciderCase } from './datasets/decider-cases';
import { PROBE_CASES, type ProbeCase } from './datasets/probe-cases';
import type { DeciderCheck } from './grading';
import { argvAffectedCases, PROMPT_TRANSPORT_REVISION } from './prompt-transport';

/** A case a decider run measures: one CLI prompt, or one cut of a captured history. */
export type MeasuredCase = DeciderCase | ProbeCase;

/**
 * Newest defined revision of the decider cases and grading. Every run records the revision it
 * started under and keeps it to the end, and every case result records the revision that
 * measured it (`prompt_revision`), so one run never mixes two gradings of a case.
 *
 * 1. Prompt passed as an argv positional (see prompt-transport.ts).
 * 2. Prompt on stdin, long-context cases with their snapshot.
 * 3. Efficient agentic probes: tool-offering turns resume a captured session that ends on a
 *    tool result, and `supp-agent-term-pwd-base` accepts only its true answer.
 *
 * The engine identity hashes the revision-2 cases. A later revision keeps that identity, so
 * every result it does not change stays reusable; {@link minimumCaseRevisions} names the
 * results it does change.
 */
export const MEASUREMENT_REVISION = 3;

/**
 * The revision every new run starts under. Raising it to a newer {@link MEASUREMENT_REVISION}
 * is a spending decision: every run the cron drain, pool admission, requeue or re-measure
 * starts afterwards measures that revision's cases, and the platform table holds publication
 * until every ready pair is measured under its grading.
 *
 * 2 is the hold. Revision 3, its probe cases, `PROBE_REVISION` and every definition it needs
 * stay defined above, and the revision-3 results already stored stay in `case_results`: the
 * publish path reads them as soon as a later deploy raises this constant again
 * (`deciderCasesForRouter(_, 3)` still returns the probe case list, `minimumCaseRevisions` and
 * `gradingRevision` still name revision 3 for it). What revision 2 does is stop *starting*
 * revision-3 work: `probesActive` in `src/run.ts`'s publish is false, so a ready pair without
 * probe results keeps every agentic route, and `applyProbeActivations` applies no staged row.
 *
 * Migration `0035_probe_activation` activated 3 in one reviewed batch. The run it started is
 * still unfinished because most of its pairs' provenance was revision 1: such a pair cannot
 * reuse the 87 argv-affected base cases, so it measures 109 fresh cases per repetition — those
 * 87, the 21 probe cuts and `supp-agent-term-pwd-base` — where the forecast priced 22. That
 * made the run cost several times its estimate. Re-activation needs, in the same change that
 * raises this constant:
 *
 * 1. a per-route minimum-coverage guard, so activating can never lower an agentic route's
 *    candidate count (an activation re-measures pairs one at a time, and the publish drops
 *    every re-measured pair from the agentic routes until its probes land);
 * 2. a priced estimate that counts those 109 fresh cases per repetition for a revision-1
 *    provenance, with the long-context cases on their own line;
 * 3. a spend cap that stops the run.
 *
 * The README's rollback section states this state and those preconditions.
 */
export const ACTIVE_MEASUREMENT_REVISION = 2;

export const ENGINE_IDENTITY_REVISION = PROMPT_TRANSPORT_REVISION;

// A client upload carries only the final text and runs a plain prompt, so client evals can
// grade neither tool evidence nor a probe.
export const CLIENT_EVAL_REVISION = PROMPT_TRANSPORT_REVISION;

/** The revision that added the efficient agentic probes. */
export const PROBE_REVISION = 3;

// The container runs each case in a fresh temp directory, so pwd never ends with /app.
export const PWD_BASE_CASE_ID = 'supp-agent-term-pwd-base';
const PWD_BASE_CHECK: DeciderCheck = { kind: 'exact', value: 'other' };

// Only this one revision-2 case changes: it stays tool-required (and so runs in its own
// workspace) and accepts only the answer that workspace produces.
function pwdBaseCase(): DeciderCase {
  const found = DECIDER_CASES.find(benchCase => benchCase.id === PWD_BASE_CASE_ID);
  if (!found) throw new Error(`${PWD_BASE_CASE_ID} is missing from the decider dataset`);
  return { ...found, requiredToolCalls: 1, check: PWD_BASE_CHECK };
}

const EFFICIENT_PROBE_CASES: readonly MeasuredCase[] = [
  ...DECIDER_CASES.map(benchCase =>
    benchCase.id === PWD_BASE_CASE_ID ? pwdBaseCase() : benchCase
  ),
  ...PROBE_CASES,
];

export function deciderCasesForRouter(
  router: AutoRouter,
  revision: number
): readonly MeasuredCase[] {
  if (router === 'frontier') return FRONTIER_CASES;
  return revision >= PROBE_REVISION ? EFFICIENT_PROBE_CASES : DECIDER_CASES;
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
  if (router === 'efficient' && revision >= PROBE_REVISION) {
    minimums[PWD_BASE_CASE_ID] = PROBE_REVISION;
    for (const probeCase of PROBE_CASES) minimums[probeCase.id] = PROBE_REVISION;
  }
  return minimums;
}

/**
 * The grading a run of `revision` applies to the router's cases, named by the revision that
 * introduced it. Two runs with equal grading revisions are comparable on every route.
 */
export function gradingRevision(router: AutoRouter, revision: number): number {
  return router === 'efficient' && revision >= PROBE_REVISION
    ? PROBE_REVISION
    : ENGINE_IDENTITY_REVISION;
}
