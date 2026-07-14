import 'server-only';

import type { CloudAgentCodeReview } from '@kilocode/db/schema';
import type { CodeReviewCouncilResult, CouncilResultSpecialist } from '@kilocode/db/schema-types';
import {
  decideCouncilFromManifest,
  enabledSpecialists,
  parseCouncilResultManifest,
} from '@kilocode/worker-utils/code-review-council';
import { getManualCodeReviewConfig } from '../manual-config';
import { setCodeReviewCouncilResult } from '../db/code-reviews';
import { logExceptInTest } from '@/lib/utils.server';

/**
 * Captures the council manifest from a completed council session's final assistant
 * message, computes the code-owned decision, and persists `council_result` for the cloud
 * UI. Fails CLOSED: if the manifest is missing/invalid (or a configured specialist did not
 * report), the decision is `block` and unreported specialists show as `abstain`.
 *
 * No-op when the review is not a council run or has no council config. Never throws — a
 * capture/persist failure must not break the status callback.
 */
export async function finalizeCouncilResultForReview(params: {
  review: CloudAgentCodeReview;
  lastAssistantMessageText: string | null | undefined;
}): Promise<void> {
  const { review, lastAssistantMessageText } = params;
  try {
    if (review.review_type !== 'council') return;
    const agentConfig = getManualCodeReviewConfig(review)?.agentConfig;
    const council = agentConfig?.council;
    if (!council) return;

    const members = enabledSpecialists(council);
    const baseModel = agentConfig.model_slug ?? null;
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
        // The model that actually ran this specialist (we assign it), for display.
        model: member.model_slug ?? baseModel,
        thinkingEffort: member.thinking_effort ?? null,
        vote: reported?.vote ?? 'abstain',
        highestSeverity: reported?.highestSeverity ?? null,
        findings: reported?.findings ?? [],
      };
    });

    const decision =
      capture.status === 'captured'
        ? decideCouncilFromManifest(configuredIds, capture.manifest, strategy).decision
        : 'block';

    const councilResult: CodeReviewCouncilResult = {
      decision,
      aggregationStrategy: strategy,
      specialists,
    };

    await setCodeReviewCouncilResult(review.id, councilResult);

    logExceptInTest('[finalize-council-result] Persisted council result', {
      reviewId: review.id,
      decision,
      captureStatus: capture.status,
      specialistCount: specialists.length,
    });
  } catch (error) {
    logExceptInTest('[finalize-council-result] Failed to persist council result', {
      reviewId: review.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
