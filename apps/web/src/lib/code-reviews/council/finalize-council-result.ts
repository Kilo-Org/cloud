import 'server-only';

import type { CloudAgentCodeReview } from '@kilocode/db/schema';
import type {
  CodeReviewCouncilConfig,
  CodeReviewCouncilResult,
  CouncilResultSpecialist,
} from '@kilocode/db/schema-types';
import {
  decideCouncilFromManifest,
  enabledSpecialists,
  parseCouncilResultManifest,
} from '@kilocode/worker-utils/code-review-council';
import { getManualCodeReviewConfig } from '../manual-config';
import { setCodeReviewCouncilResult } from '../db/code-reviews';
import { logExceptInTest } from '@/lib/utils.server';

/**
 * Pure mapping: captures the council manifest from the final assistant message, computes
 * the code-owned decision, and joins each configured specialist with its reported
 * vote/findings into the persisted `CodeReviewCouncilResult`.
 *
 * Fails CLOSED: a missing/invalid manifest → `decision: 'block'`; a configured specialist
 * absent from the manifest → `abstain` (and, via `decideCouncilFromManifest`, blocks).
 *
 * TODO(council): the `decision` here is ADVISORY for PR4 — a pass/fail score surfaced in the
 * cloud UI only. It is NOT yet wired into the PR merge gate (`gateResult`), so a council
 * `block` does not hard-block the PR. Threading the code-owned decision into `gateResult`
 * (so `block` actually fails the merge check) is deferred to a later PR — see the council
 * plan's beta-readiness gate ("Validate the council PR output in a deployed run"). Keep the
 * UI copy in `CouncilGovernancePanel` in sync with this advisory-only status.
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
      vote: reported?.vote ?? 'abstain',
      highestSeverity: reported?.highestSeverity ?? null,
      findings: reported?.findings ?? [],
    };
  });

  const decision =
    capture.status === 'captured'
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
}): CodeReviewCouncilResult | null {
  const { review, lastAssistantMessageText } = params;
  if (review.review_type !== 'council') return null;
  const agentConfig = getManualCodeReviewConfig(review)?.agentConfig;
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
}): Promise<void> {
  const councilResult = computeCouncilResultForReview(params);
  if (!councilResult) return;

  await setCodeReviewCouncilResult(params.review.id, councilResult);

  logExceptInTest('[finalize-council-result] Persisted council result', {
    reviewId: params.review.id,
    decision: councilResult.decision,
    specialistCount: councilResult.specialists.length,
  });
}
