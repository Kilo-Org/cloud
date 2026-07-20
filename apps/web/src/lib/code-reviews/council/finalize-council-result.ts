import 'server-only';

import type { CloudAgentCodeReview } from '@kilocode/db/schema';
import type {
  CodeReviewAgentConfig,
  CodeReviewCouncilConfig,
  CodeReviewCouncilResult,
  CouncilResultSpecialist,
} from '@kilocode/db/schema-types';
import {
  decideCouncilFromManifest,
  deriveSpecialistVote,
  enabledSpecialists,
  highestSeverityOf,
  parseCouncilResultManifest,
} from '@kilocode/worker-utils/code-review-council';
import { getManualCodeReviewConfig } from '../manual-config';
import { setCodeReviewCouncilResult } from '../db/code-reviews';
import { logExceptInTest } from '@/lib/utils.server';

/**
 * Pure mapping: captures the council manifest from the final assistant message and joins each
 * configured specialist with its reported findings into the persisted `CodeReviewCouncilResult`.
 * The model reports findings only; this DERIVES each specialist's binary vote
 * (`deriveSpecialistVote`) and computes the aggregate decision.
 *
 * Decision semantics (v2):
 * - `advisory` governance always returns `decision: null` (no aggregate verdict, no gate),
 *   independent of whether the manifest was captured.
 * - `unanimous`/`majority` defer to `decideCouncilFromManifest`, which FAILS CLOSED to `block`
 *   on a missing/invalid manifest or on any missing specialist coverage.
 *
 * A specialist that did not return a reliable result is shown as `vote: null` ("no result"),
 * which is distinct from a `block` vote (a `block` vote means the specialist reported a critical).
 *
 * NOTE: the decision is not yet wired into the PR merge gate (`gateResult`), so a `block` does
 * not hard-block the PR today. Injecting the decision into the gate + PR summary is a follow-up.
 */
export function buildCouncilResult(params: {
  council: CodeReviewCouncilConfig;
  baseModel: string | null;
  baseThinkingEffort: string | null;
  lastAssistantMessageText: string | null | undefined;
}): CodeReviewCouncilResult {
  const { council, baseModel, baseThinkingEffort, lastAssistantMessageText } = params;
  const members = enabledSpecialists(council);
  const strategy = council.aggregation_strategy;
  const configuredIds = members.map(member => member.id);
  const capture = parseCouncilResultManifest(lastAssistantMessageText);

  const reportedById =
    capture.status === 'captured'
      ? new Map(
          capture.manifest.specialists.map(specialist => [specialist.specialistId, specialist])
        )
      : new Map();

  const specialists: CouncilResultSpecialist[] = members.map(member => {
    const reported = reportedById.get(member.id);
    return {
      id: member.id,
      role: member.role,
      name: member.name,
      // The model that actually ran this specialist, for display. Prefer the concrete model
      // the specialist REPORTED (resolves an "auto" slug to what really ran); fall back to
      // the model we configured for it, then the review's base model. The configured value
      // is what we hand cloud-agent-next in `buildCouncilRuntimeAgents`, so the fallback
      // still reflects the request even when the specialist doesn't self-report.
      model: reported?.model ?? member.model_slug ?? baseModel,
      // Mirror `buildCouncilRuntimeAgents`: only inherit the base effort when the specialist
      // also inherited the base model (variants are model-specific). A specialist on its own
      // model shows no effort unless it set one.
      thinkingEffort: member.thinking_effort ?? (member.model_slug ? null : baseThinkingEffort),
      // v2: vote + highest severity are DERIVED from the reported findings, never model-authored.
      // A specialist that did NOT report shows `vote: null` ("no result") — distinct from a
      // `block` vote (which means it reported a critical). The aggregate decision below still
      // fails closed on this missing coverage for enforcing modes.
      vote: reported ? deriveSpecialistVote(reported.findings) : null,
      highestSeverity: reported ? highestSeverityOf(reported.findings) : null,
      findings: reported?.findings ?? [],
    };
  });

  // Advisory → no aggregate verdict (null). Otherwise: a captured manifest decides via
  // `decideCouncilFromManifest` (coverage-checked, fail-closed); a missing/invalid manifest
  // (no coverage) fails closed to `block`.
  const decision =
    strategy === 'advisory'
      ? null
      : capture.status === 'captured'
        ? decideCouncilFromManifest(configuredIds, capture.manifest, strategy).decision
        : 'block';

  return { decision, aggregationStrategy: strategy, specialists };
}

/**
 * Pure: derives the council result for a completed review from its stored council config +
 * the final assistant message. Returns null when the review is not a council run or has no
 * council config (nothing to persist). No DB access, never throws (fails closed to `block`).
 */
export function computeCouncilResultForReview(params: {
  review: CloudAgentCodeReview;
  lastAssistantMessageText: string | null | undefined;
  // Council-config source for AUTOMATED (webhook) reviews, which carry no `manual_config`.
  // Manual reviews resolve their council from `manual_config` and ignore this. Resolved + passed
  // by the caller (the status callback) because this function is pure/DB-free and also runs inside
  // the analytics completion transaction. Absent → automated council reviews persist no result.
  orgAgentConfig?: CodeReviewAgentConfig | null;
}): CodeReviewCouncilResult | null {
  const { review, lastAssistantMessageText } = params;
  if (review.review_type !== 'council') return null;
  const agentConfig =
    getManualCodeReviewConfig(review)?.agentConfig ?? params.orgAgentConfig ?? null;
  const council = agentConfig?.council;
  if (!council) return null;

  return buildCouncilResult({
    council,
    baseModel: agentConfig.model_slug ?? null,
    baseThinkingEffort: agentConfig.thinking_effort ?? null,
    lastAssistantMessageText,
  });
}

/**
 * Captures a completed council session's outcome and persists `council_result` for the
 * cloud UI. No-op when the review is not a council run or has no council config.
 *
 * Used only on the NON-analytics completion path — there this write runs BEFORE the review
 * is marked completed, so a thrown error fails the status callback and cloud-agent-next
 * redelivers it (retrying the write) rather than leaving a `completed` council run without a
 * result. `computeCouncilResultForReview` is pure and never throws, so the only failure here
 * is the DB write, which is exactly what we want to retry.
 *
 * The ANALYTICS completion path does NOT use this — it marks the parent completed inside a
 * transaction, so it persists `council_result` in that SAME transaction (atomic) instead;
 * otherwise a completed-but-council-write-failed run could never be repaired (redelivery
 * short-circuits on the already-terminal parent).
 */
export async function finalizeCouncilResultForReview(params: {
  review: CloudAgentCodeReview;
  lastAssistantMessageText: string | null | undefined;
  orgAgentConfig?: CodeReviewAgentConfig | null;
}): Promise<CodeReviewCouncilResult | null> {
  const councilResult = computeCouncilResultForReview(params);
  if (!councilResult) return null;

  await setCodeReviewCouncilResult(params.review.id, councilResult);

  logExceptInTest('[finalize-council-result] Persisted council result', {
    reviewId: params.review.id,
    decision: councilResult.decision,
    specialistCount: councilResult.specialists.length,
  });

  return councilResult;
}
