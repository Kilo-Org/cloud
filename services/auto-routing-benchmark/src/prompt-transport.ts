import type { AutoRouter } from '@kilocode/auto-routing-contracts';
import { deciderCliPrompt } from './cli-runner';
import { DECIDER_CASES, FRONTIER_CASES, type DeciderCase } from './datasets/decider-cases';
import { materializeLongContext } from './datasets/long-context';

/**
 * How the decider prompt reached `kilo run`, recorded on every case result and pending
 * output. Revision 1 passed the prompt as an argv positional without the long-context
 * snapshot: the CLI wrapped it in double quotes and backslash-escaped inner quotes.
 * Revision 2 materializes long-context cases and writes the prompt to stdin verbatim.
 * Older rows default to 1. The engine identity did not change, so this is what tells
 * old measurements of an affected case apart.
 */
export const PROMPT_TRANSPORT_REVISION = 2;

// Frontier cases with an inner double quote, not long-context, may also have been graded
// against the rewritten prompt. Off until measurements show they were.
export const REMEASURE_FRONTIER_INNER_QUOTE_CASES = false;

const QUOTE_SENSITIVE_CHECKS: ReadonlySet<DeciderCase['check']['kind']> = new Set([
  'exact',
  'contains_all',
  'regex',
]);

/**
 * Whether a revision-1 result for this case is unreliable: every long-context case ran
 * without its snapshot, and efficient cases with an inner quote and a quote-sensitive
 * check were graded against answers that echoed the CLI's added quotes.
 */
export function affectedByArgvTransport(
  router: AutoRouter,
  benchCase: DeciderCase,
  options: { frontierInnerQuotes?: boolean } = {}
): boolean {
  if (benchCase.longContext) return true;
  if (!deciderCliPrompt(benchCase).includes('"')) return false;
  if (router === 'frontier') {
    return options.frontierInnerQuotes ?? REMEASURE_FRONTIER_INNER_QUOTE_CASES;
  }
  return QUOTE_SENSITIVE_CHECKS.has(benchCase.check.kind);
}

export function argvAffectedCases(
  router: AutoRouter,
  options: { frontierInnerQuotes?: boolean } = {}
): DeciderCase[] {
  const cases = router === 'frontier' ? FRONTIER_CASES : DECIDER_CASES;
  return cases.filter(benchCase => affectedByArgvTransport(router, benchCase, options));
}

/** Prompt tokens a long-context case adds over its revision-1 prompt, at four chars per token. */
export function snapshotPromptTokens(benchCase: DeciderCase): number {
  if (!benchCase.longContext) return 0;
  const materialized = materializeLongContext(benchCase);
  const added =
    materialized.systemPrompt.length +
    materialized.userPrompt.length -
    benchCase.systemPrompt.length -
    benchCase.userPrompt.length;
  return Math.ceil(Math.max(0, added) / 4);
}
