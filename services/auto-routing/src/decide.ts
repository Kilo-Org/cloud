import type { Handler } from 'hono';
import { writeClassifierMetricsDataPoint } from './classifier-analytics';
import { mirrorPayloadSchema, parseClassifierInput } from './classifier-input';
import { classifyNormalizedInput } from './model-classifier';
import type { HonoEnv } from './hono-env';

function emptyDecisionResponse() {
  return {
    cost: 0,
    decision: null,
    classifierResult: null,
  };
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
      bodyBytes,
    });
    return c.json(emptyDecisionResponse());
  }

  const startedAt = performance.now();
  try {
    const classifier = await classifyNormalizedInput(c.env, classifierInput.data);
    const classifierLatencyMs = performance.now() - startedAt;
    writeClassifierMetricsDataPoint(c.env, {
      status: 'classified',
      classifierModel: classifier.classifierModel,
      input: classifierInput.data,
      classification: classifier.classification,
      classifierCost: classifier.cost,
      classifierLatencyMs,
      bodyBytes,
    });
    return c.json({
      cost: classifier.cost ?? 0,
      decision: null,
      classifierResult: {
        classification: classifier.classification,
        normalized: classifierInput.data,
      },
    });
  } catch {
    const classifierLatencyMs = performance.now() - startedAt;
    writeClassifierMetricsDataPoint(c.env, {
      status: 'classifier_error',
      input: classifierInput.data,
      classifierLatencyMs,
      bodyBytes,
    });
    return c.json(emptyDecisionResponse());
  }
};
