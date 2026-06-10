import type { NormalizedClassifierInput } from './classifier-input';
import type { ClassifierOutput } from './classification';

type ClassifierAnalyticsStatus =
  | 'classified'
  | 'invalid_json'
  | 'invalid_envelope'
  | 'invalid_body'
  | 'classifier_error';

type ClassifierAnalyticsParams = {
  status: ClassifierAnalyticsStatus;
  classifierModel?: string | null;
  sessionId?: string | null;
  input?: NormalizedClassifierInput;
  classification?: ClassifierOutput;
  classifierDurationMs?: number;
  classifierCostCredits?: number | null;
  bodyBytes?: number;
};

type ClassifierAnalyticsEnv = Pick<Env, 'AUTO_ROUTING_CLASSIFIER_METRICS'>;

/**
 * Analytics Engine schema:
 *   index1  = classifierModel, or "unknown" when no classifier call happened
 *   blob1   = classifierModel
 *   blob2   = requestedModel
 *   blob3   = apiKind
 *   blob4   = status
 *   blob5   = taskType
 *   blob6   = subtaskType
 *   blob7   = contextComplexity
 *   blob8   = reasoningComplexity
 *   blob9   = executionMode
 *   blob10  = "1" if classified request requires tools, "0" if not, "" if unknown
 *   blob11  = confidence bucket
 *   blob12  = sessionId, or "" when absent/unavailable
 *   double1 = classifierDurationMs
 *   double2 = classifierCostCredits
 *   double3 = confidence, or -1 if unavailable
 *   double4 = messageCount
 *   double5 = "1" if mirrored request includes tools, "0" if not
 *   double6 = mirrored body bytes
 */
export function writeClassifierMetricsDataPoint(
  env: ClassifierAnalyticsEnv,
  params: ClassifierAnalyticsParams
): void {
  const classifierModel = params.classifierModel || 'unknown';
  const classification = params.classification;
  const input = params.input;

  try {
    env.AUTO_ROUTING_CLASSIFIER_METRICS.writeDataPoint({
      indexes: [classifierModel],
      blobs: [
        classifierModel,
        input?.requestedModel ?? '',
        input?.apiKind ?? '',
        params.status,
        classification?.taskType ?? '',
        classification?.subtaskType ?? '',
        classification?.contextComplexity ?? '',
        classification?.reasoningComplexity ?? '',
        classification?.executionMode ?? '',
        classification ? (classification.requiresTools ? '1' : '0') : '',
        classification ? confidenceBucket(classification.confidence) : '',
        params.sessionId ?? '',
      ],
      doubles: [
        params.classifierDurationMs ?? 0,
        params.classifierCostCredits ?? 0,
        classification?.confidence ?? -1,
        input?.messageCount ?? 0,
        input?.hasTools ? 1 : 0,
        params.bodyBytes ?? 0,
      ],
    });
  } catch {
    // Best effort only. Analytics must not affect routing responses.
  }
}

function confidenceBucket(confidence: number): string {
  if (confidence < 0.2) return '0.0-0.2';
  if (confidence < 0.4) return '0.2-0.4';
  if (confidence < 0.6) return '0.4-0.6';
  if (confidence < 0.8) return '0.6-0.8';
  return '0.8-1.0';
}
