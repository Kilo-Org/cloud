import type { ClassifierOutput } from '@kilocode/auto-routing-contracts/classifier';

export type ClassifierAnalyticsStatus =
  | 'classified'
  | 'invalid_json'
  | 'invalid_envelope'
  | `fallback:${string}`
  | `classifier_error:${string}`;

type ClassifierAnalyticsParams = {
  status: ClassifierAnalyticsStatus;
  classifierModel?: string | null;
  requestedModel?: string;
  classification?: ClassifierOutput;
  classifierDurationMs?: number;
  classifierCostCredits?: number | null;
  cacheHit?: boolean;
};

type ClassifierAnalyticsEnv = Pick<Env, 'AUTO_ROUTING_CLASSIFIER_METRICS_V2'>;

/**
 * Analytics Engine schema (v2 dataset). Only fields the admin panel or
 * future routing-decision analysis consume are recorded; request-level
 * context (apiKind, sessionId, messageCount, body bytes) lives in the
 * sampled auto_routing_decision logs instead.
 *   index1  = classifierModel, or "unknown" when no classifier call happened
 *   blob1   = classifierModel
 *   blob2   = requestedModel
 *   blob3   = status; heuristic fallbacks use fallback:<reason>, classifier
 *             failures use classifier_error:<subtype>. Fallbacks still carry
 *             a classification, so "produced a classification" queries must
 *             match both 'classified' and 'fallback:%'.
 *   blob4   = taskType
 *   blob5   = subtaskType
 *   blob6   = contextComplexity
 *   blob7   = reasoningComplexity
 *   blob8   = executionMode
 *   blob9   = "1" if classified request requires tools, "0" if not, "" if unknown
 *   double1 = classifier model-call duration ms; forced to 0 for cache hits
 *             so duration queries (which filter double1 > 0) keep measuring
 *             model calls only — filter on double4, not the 0 sentinel, to
 *             select cache hits
 *   double2 = classifierCostCredits
 *   double3 = confidence, or -1 if unavailable
 *   double4 = "1" if the classification was served from cache, "0" if not
 */
export function writeClassifierMetricsDataPoint(
  env: ClassifierAnalyticsEnv,
  params: ClassifierAnalyticsParams
): void {
  const classifierModel = params.classifierModel || 'unknown';
  const classification = params.classification;

  try {
    env.AUTO_ROUTING_CLASSIFIER_METRICS_V2.writeDataPoint({
      indexes: [classifierModel],
      blobs: [
        classifierModel,
        params.requestedModel ?? '',
        params.status,
        classification?.taskType ?? '',
        classification?.subtaskType ?? '',
        classification?.contextComplexity ?? '',
        classification?.reasoningComplexity ?? '',
        classification?.executionMode ?? '',
        classification ? (classification.requiresTools ? '1' : '0') : '',
      ],
      doubles: [
        params.cacheHit ? 0 : (params.classifierDurationMs ?? 0),
        params.classifierCostCredits ?? 0,
        classification?.confidence ?? -1,
        params.cacheHit ? 1 : 0,
      ],
    });
  } catch {
    // Best effort only. Analytics must not affect routing responses.
  }
}
