import type { AutoRoutingDecisionResponse } from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import type { Handler } from 'hono';
import { writeClassifierMetricsDataPoint } from './classifier-analytics';
import { getClassifierModel, getDecisionLogSampleRate } from './classifier-config';
import { mirrorPayloadSchema, parseClassifierInput } from './classifier-input';
import type { NormalizedClassifierInput } from './classifier-input';
import { getCachedClassification, putCachedClassification } from './decision-cache';
import { ClassifierRunError, classifyNormalizedInput } from './model-classifier';
import type { ClassifierModelCallMeta, ClassifierRunFallbackMetadata } from './model-classifier';
import type { HonoEnv } from './hono-env';

// Isolate-scoped request counter, used to correlate latency with isolate
// warm-up in logs.
let isolateRequestSeq = 0;

type ContentHashes = {
  // Includes the bucketed message count, so it only matches requests at a
  // similar conversation depth.
  exact: string;
  // Ignores message count entirely; matches any request with the same
  // prompt prefixes.
  loose: string;
};

function messageCountBucket(messageCount: number | null): number {
  if (messageCount === null || messageCount < 1) return -1;
  return Math.floor(Math.log2(messageCount));
}

async function sha256Hex16(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function computeContentHashes(input: NormalizedClassifierInput): Promise<ContentHashes> {
  const base = [
    input.apiKind,
    input.hasTools ? '1' : '0',
    input.systemPromptPrefix?.slice(0, 200) ?? '',
    input.userPromptPrefix?.slice(0, 800) ?? '',
    input.latestUserPromptPrefix?.slice(0, 800) ?? '',
  ].join('|');
  const [loose, exact] = await Promise.all([
    sha256Hex16(base),
    sha256Hex16(`${base}|${messageCountBucket(input.messageCount)}`),
  ]);
  return { exact, loose };
}

function logDecision({
  status,
  successSampleRate,
  classifierModel,
  classifierInput,
  sessionId,
  headers,
  hashes,
  reqSeq,
  colo,
  classifierDurationMs,
  classifierCostCredits,
  bodyBytes,
  taskType,
  subtaskType,
  confidence,
  modelCallMeta,
  fallbackReason,
  cacheHit,
  retried,
}: {
  status: string;
  successSampleRate: number;
  classifierModel: string | null;
  classifierInput: NormalizedClassifierInput;
  sessionId: string | null;
  headers: Record<string, string>;
  hashes: ContentHashes;
  reqSeq: number;
  colo: string | null;
  classifierDurationMs: number;
  classifierCostCredits: number | null;
  bodyBytes: number;
  taskType?: string;
  subtaskType?: string;
  confidence?: number;
  modelCallMeta?: ClassifierModelCallMeta;
  fallbackReason?: string;
  cacheHit?: boolean;
  retried?: boolean;
}) {
  const isFailure = Boolean(fallbackReason) || status.startsWith('classifier_error');
  if (!isFailure && Math.random() >= successSampleRate) {
    return;
  }
  console.log(
    JSON.stringify({
      event: 'auto_routing_decision',
      status,
      cacheHit: cacheHit ?? false,
      retried: retried ?? false,
      classifierModel,
      requestedModel: classifierInput.requestedModel,
      apiKind: classifierInput.apiKind,
      sessionId,
      hashExact: hashes.exact,
      hashLoose: hashes.loose,
      reqSeq,
      colo,
      classifierDurationMs: Math.round(classifierDurationMs),
      classifierCostCredits,
      messageCount: classifierInput.messageCount,
      bodyBytes,
      taskType: taskType ?? null,
      subtaskType: subtaskType ?? null,
      confidence: confidence ?? null,
      hasMachineId: 'x-kilocode-machineid' in headers,
      hasClientRequestId: 'x-kilo-request' in headers,
      mode: headers['x-kilocode-mode'] ?? null,
      uaPrefix: headers['user-agent']?.slice(0, 40) ?? null,
      ...(fallbackReason ? { fallbackReason } : {}),
      ...(modelCallMeta
        ? {
            finishReason: modelCallMeta.finishReason,
            completionTokens: modelCallMeta.completionTokens,
            reasoningTokens: modelCallMeta.reasoningTokens,
            ...(isFailure
              ? { textHead: modelCallMeta.textHead, textTail: modelCallMeta.textTail }
              : {}),
          }
        : {}),
    })
  );
}

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

  const reqSeq = isolateRequestSeq++;
  const colo = (c.req.raw.cf?.colo as string | undefined) ?? null;
  const startedAt = performance.now();
  const [hashes, classifierModel, successSampleRate] = await Promise.all([
    computeContentHashes(classifierInput.data),
    getClassifierModel(c.env),
    getDecisionLogSampleRate(c.env),
  ]);
  // Stable conversation identity even when the client sends no session id:
  // the first user prompt and system prompt do not change within a
  // conversation, so their fingerprint identifies it.
  const conversationKey = parsed.data.sessionId ?? `content:${hashes.loose}`;

  const cached = await getCachedClassification(
    c.env,
    conversationKey,
    hashes.exact,
    classifierModel
  );
  if (cached) {
    const classifierDurationMs = performance.now() - startedAt;
    writeClassifierMetricsDataPoint(c.env, {
      status: 'classified',
      classifierModel,
      sessionId: parsed.data.sessionId,
      input: classifierInput.data,
      classification: cached.classification,
      classifierCostCredits: 0,
      // Keep double1 as the model-call duration so cache hits do not skew
      // the existing duration analytics.
      classifierDurationMs: 0,
      bodyBytes,
      cacheHit: true,
    });
    logDecision({
      status: 'classified',
      successSampleRate,
      cacheHit: true,
      classifierModel,
      classifierInput: classifierInput.data,
      sessionId: parsed.data.sessionId,
      headers: parsed.data.headers,
      hashes,
      reqSeq,
      colo,
      classifierDurationMs,
      classifierCostCredits: 0,
      bodyBytes,
      taskType: cached.classification.taskType,
      subtaskType: cached.classification.subtaskType,
      confidence: cached.classification.confidence,
    });
    const response: AutoRoutingDecisionResponse = {
      cost: 0,
      decision: null,
      classifierResult: {
        classification: cached.classification,
        normalized: classifierInput.data,
      },
    };
    return c.json(response);
  }

  try {
    const classifier = await classifyNormalizedInput(c.env, classifierInput.data, {
      openrouterSessionId: conversationKey,
    });
    const classifierDurationMs = performance.now() - startedAt;
    if (!classifier.fallback) {
      const cacheWrite = putCachedClassification(
        c.env,
        conversationKey,
        hashes.exact,
        classifier.classifierModel,
        classifier.classification
      );
      try {
        c.executionCtx.waitUntil(cacheWrite);
      } catch {
        // No execution context outside the workers runtime; the write is
        // already running and best effort.
      }
    }
    logDecision({
      status: classifier.fallback ? `fallback:${classifier.fallback.reason}` : 'classified',
      successSampleRate,
      retried: classifier.retried,
      classifierModel: classifier.classifierModel,
      classifierInput: classifierInput.data,
      sessionId: parsed.data.sessionId,
      headers: parsed.data.headers,
      hashes,
      reqSeq,
      colo,
      classifierDurationMs,
      classifierCostCredits: classifier.cost,
      bodyBytes,
      taskType: classifier.classification.taskType,
      subtaskType: classifier.classification.subtaskType,
      confidence: classifier.classification.confidence,
      modelCallMeta: classifier.modelCallMeta,
      fallbackReason: classifier.fallback?.reason,
    });
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
    logDecision({
      status: classifierErrorStatus(error),
      successSampleRate,
      classifierModel: classifierFailureMetadata.classifierModel ?? null,
      classifierInput: classifierInput.data,
      sessionId: parsed.data.sessionId,
      headers: parsed.data.headers,
      hashes,
      reqSeq,
      colo,
      classifierDurationMs,
      classifierCostCredits: classifierFailureMetadata.cost ?? null,
      bodyBytes,
    });
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
