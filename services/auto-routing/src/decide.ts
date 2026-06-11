import type { AutoRoutingDecisionResponse } from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import type { Handler } from 'hono';
import { writeClassifierMetricsDataPoint } from './classifier-analytics';
import { mirrorPayloadSchema, parseClassifierInput } from './classifier-input';
import type { NormalizedClassifierInput } from './classifier-input';
import { ClassifierRunError, classifyNormalizedInput } from './model-classifier';
import type { ClassifierRunFallbackMetadata } from './model-classifier';
import type { HonoEnv } from './hono-env';

function emptyDecisionResponse(): AutoRoutingDecisionResponse {
  return {
    cost: 0,
    decision: null,
    classifierResult: null,
  };
}

function getClassifierFailureMetadata(error: unknown): {
  cost?: number | null;
  classifierModel?: string;
  failureStage?: string;
  schemaIssueSummary?: string[];
  topLevelKeys?: string[];
} {
  if (error instanceof ClassifierRunError) {
    return {
      cost: error.cost,
      classifierModel: error.classifierModel,
      failureStage: error.failureStage,
      schemaIssueSummary: error.schemaIssueSummary,
      topLevelKeys: error.topLevelKeys,
    };
  }
  return {};
}

function getClassifierFailureReason(error: unknown): string {
  if (error instanceof ClassifierRunError) {
    return 'classifier_run_error';
  }
  return 'unexpected_error';
}

function classifierErrorStatus(error: unknown): `classifier_error:${string}` {
  if (error instanceof ClassifierRunError) {
    return `classifier_error:${error.failureStage ?? 'run_error'}`;
  }
  if (error instanceof Error && error.message.startsWith('Secrets Worker:')) {
    return 'classifier_error:secret_error';
  }
  return 'classifier_error:unexpected_error';
}

function logClassifierError({
  error,
  classifierInput,
  classifierDurationMs,
  classifierCostCredits,
  classifierModel,
  failureStage,
  schemaIssueSummary,
  topLevelKeys,
  sessionId,
}: {
  error: unknown;
  classifierInput: NormalizedClassifierInput;
  classifierDurationMs: number;
  classifierCostCredits?: number | null;
  classifierModel?: string;
  failureStage?: string;
  schemaIssueSummary?: string[];
  topLevelKeys?: string[];
  sessionId: string | null;
}) {
  console.warn(
    JSON.stringify({
      event: 'auto_routing_classifier_error',
      reason: getClassifierFailureReason(error),
      classifierModel: classifierModel ?? 'unknown',
      requestedModel: classifierInput.requestedModel,
      apiKind: classifierInput.apiKind,
      sessionId,
      classifierDurationMs,
      classifierCostCredits: classifierCostCredits ?? null,
      ...(failureStage ? { classifierFailureStage: failureStage } : {}),
      ...(schemaIssueSummary && schemaIssueSummary.length > 0
        ? { classifierSchemaIssueSummary: schemaIssueSummary }
        : {}),
      ...(topLevelKeys && topLevelKeys.length > 0
        ? { classifierOutputTopLevelKeys: topLevelKeys }
        : {}),
      ...formatError(error),
    })
  );
}

function logClassifierFallback({
  classifierInput,
  classifierDurationMs,
  classifierCostCredits,
  classifierModel,
  sessionId,
  fallback,
}: {
  classifierInput: NormalizedClassifierInput;
  classifierDurationMs: number;
  classifierCostCredits: number | null;
  classifierModel: string;
  sessionId: string | null;
  fallback: ClassifierRunFallbackMetadata;
}) {
  console.warn(
    JSON.stringify({
      event: 'auto_routing_classifier_fallback',
      reason: fallback.reason,
      classifierModel,
      requestedModel: classifierInput.requestedModel,
      apiKind: classifierInput.apiKind,
      sessionId,
      classifierDurationMs,
      classifierCostCredits: classifierCostCredits ?? null,
      ...(fallback.failureStage ? { classifierFailureStage: fallback.failureStage } : {}),
      ...(fallback.schemaIssueSummary && fallback.schemaIssueSummary.length > 0
        ? { classifierSchemaIssueSummary: fallback.schemaIssueSummary }
        : {}),
      ...(fallback.topLevelKeys && fallback.topLevelKeys.length > 0
        ? { classifierOutputTopLevelKeys: fallback.topLevelKeys }
        : {}),
    })
  );
}

export const decideHandler: Handler<HonoEnv> = async c => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    writeClassifierMetricsDataPoint(c.env, { status: 'invalid_json' });
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = mirrorPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    writeClassifierMetricsDataPoint(c.env, { status: 'invalid_envelope' });
    return c.json({ error: 'Invalid classifier payload' }, 400);
  }

  const bodyBytes = new TextEncoder().encode(parsed.data.body).byteLength;
  const classifierInput = parseClassifierInput(parsed.data);
  if (!classifierInput.success) {
    writeClassifierMetricsDataPoint(c.env, {
      status: 'invalid_body',
      sessionId: parsed.data.sessionId,
      bodyBytes,
    });
    return c.json(emptyDecisionResponse());
  }

  const startedAt = performance.now();
  try {
    const classifier = await classifyNormalizedInput(c.env, classifierInput.data);
    const classifierDurationMs = performance.now() - startedAt;
    writeClassifierMetricsDataPoint(c.env, {
      status: 'classified',
      classifierModel: classifier.classifierModel,
      sessionId: parsed.data.sessionId,
      input: classifierInput.data,
      classification: classifier.classification,
      classifierCostCredits: classifier.cost,
      classifierDurationMs,
      bodyBytes,
    });
    if (classifier.fallback) {
      logClassifierFallback({
        classifierInput: classifierInput.data,
        classifierDurationMs,
        classifierCostCredits: classifier.cost,
        classifierModel: classifier.classifierModel,
        sessionId: parsed.data.sessionId,
        fallback: classifier.fallback,
      });
    }
    // When routing decisions are implemented, include the prior decision for
    // this session as an input alongside classifier output.
    const response: AutoRoutingDecisionResponse = {
      cost: classifier.cost ?? 0,
      decision: null,
      classifierResult: {
        classification: classifier.classification,
        normalized: classifierInput.data,
      },
    };
    return c.json(response);
  } catch (error) {
    const classifierDurationMs = performance.now() - startedAt;
    const classifierFailureMetadata = getClassifierFailureMetadata(error);
    logClassifierError({
      error,
      classifierInput: classifierInput.data,
      classifierDurationMs,
      classifierCostCredits: classifierFailureMetadata.cost,
      classifierModel: classifierFailureMetadata.classifierModel,
      failureStage: classifierFailureMetadata.failureStage,
      schemaIssueSummary: classifierFailureMetadata.schemaIssueSummary,
      topLevelKeys: classifierFailureMetadata.topLevelKeys,
      sessionId: parsed.data.sessionId,
    });
    writeClassifierMetricsDataPoint(c.env, {
      status: classifierErrorStatus(error),
      classifierModel: classifierFailureMetadata.classifierModel,
      sessionId: parsed.data.sessionId,
      input: classifierInput.data,
      classifierCostCredits: classifierFailureMetadata.cost,
      classifierDurationMs,
      bodyBytes,
    });
    return c.json(emptyDecisionResponse());
  }
};
