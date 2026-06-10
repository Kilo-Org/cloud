import type { AutoRoutingDecisionResponse } from '@kilocode/auto-routing-contracts';
import type { Handler } from 'hono';
import { writeClassifierMetricsDataPoint } from './classifier-analytics';
import { mirrorPayloadSchema, parseClassifierInput } from './classifier-input';
import { ClassifierRunError, classifyNormalizedInput } from './model-classifier';
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
} {
  if (error instanceof ClassifierRunError) {
    return { cost: error.cost, classifierModel: error.classifierModel };
  }
  return {};
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
    writeClassifierMetricsDataPoint(c.env, {
      status: 'classifier_error',
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
