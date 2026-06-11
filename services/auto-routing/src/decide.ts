import type { AutoRoutingDecisionResponse } from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import type { Handler } from 'hono';
import { writeClassifierMetricsDataPoint } from './classifier-analytics';
import { getClassifierModel, getDecisionLogSampleRate } from './classifier-config';
import { mirrorPayloadSchema, parseClassifierInput } from './classifier-input';
import type { NormalizedClassifierInput } from './classifier-input';
import type { ClassifierOutput } from './classifier-output';
import { computeContentHashes, deriveConversationKey } from './conversation-identity';
import type { ContentHashes } from './conversation-identity';
import { getCachedClassification, putCachedClassification } from './decision-cache';
import { ClassifierRunError, classifyNormalizedInput } from './model-classifier';
import type { ClassifierRunResult } from './model-classifier';
import type { HonoEnv } from './hono-env';

// Isolate-scoped request counter, used to correlate latency with isolate
// warm-up in logs.
let isolateRequestSeq = 0;

const textEncoder = new TextEncoder();

function decisionResponse(
  cost: number,
  classification: ClassifierOutput,
  normalized: NormalizedClassifierInput
): AutoRoutingDecisionResponse {
  return {
    cost,
    decision: null,
    classifierResult: { classification, normalized },
  };
}

function emptyDecisionResponse(cost = 0): AutoRoutingDecisionResponse {
  return {
    cost,
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

// Per-request fields shared by every metrics write and log line for the
// decision, assembled once after the mirrored payload is parsed.
type DecisionContext = {
  classifierInput: NormalizedClassifierInput;
  sessionId: string | null;
  headers: Record<string, string>;
  hashes: ContentHashes;
  conversationKey: string;
  reqSeq: number;
  colo: string | null;
  bodyBytes: number;
  successSampleRate: number;
};

type DecisionOutcome =
  | { kind: 'cache_hit'; classifierModel: string; classification: ClassifierOutput }
  | { kind: 'model'; classifier: ClassifierRunResult }
  | { kind: 'error'; error: unknown };

type DecisionSummary = {
  status: string;
  classifierModel: string | null;
  classification?: ClassifierOutput;
  cost: number | null;
  cacheHit: boolean;
  retried: boolean;
  // Outcome-specific log fields (model-call metadata, failure diagnostics).
  details: Record<string, unknown>;
};

function summarizeOutcome(outcome: DecisionOutcome): DecisionSummary {
  switch (outcome.kind) {
    case 'cache_hit':
      return {
        status: 'classified',
        classifierModel: outcome.classifierModel,
        classification: outcome.classification,
        cost: 0,
        cacheHit: true,
        retried: false,
        details: {},
      };
    case 'model': {
      const { classifier } = outcome;
      const meta = classifier.modelCallMeta;
      const callDetails = {
        ...(meta
          ? {
              finishReason: meta.finishReason,
              completionTokens: meta.completionTokens,
              reasoningTokens: meta.reasoningTokens,
            }
          : {}),
        ...(classifier.firstAttemptFailure
          ? { firstAttemptFailure: classifier.firstAttemptFailure }
          : {}),
      };
      const fallback = classifier.fallback;
      return {
        status: fallback ? `fallback:${fallback.reason}` : 'classified',
        classifierModel: classifier.classifierModel,
        classification: classifier.classification,
        cost: classifier.cost,
        cacheHit: false,
        retried: classifier.retried ?? false,
        details: fallback
          ? {
              ...callDetails,
              fallbackReason: fallback.reason,
              ...(fallback.failureStage ? { classifierFailureStage: fallback.failureStage } : {}),
              ...(fallback.schemaIssueSummary?.length
                ? { classifierSchemaIssueSummary: fallback.schemaIssueSummary }
                : {}),
              ...(fallback.topLevelKeys?.length
                ? { classifierOutputTopLevelKeys: fallback.topLevelKeys }
                : {}),
              ...(meta ? { textLength: meta.textLength } : {}),
            }
          : callDetails,
      };
    }
    case 'error': {
      const metadata = getClassifierFailureMetadata(outcome.error);
      return {
        status: classifierErrorStatus(outcome.error),
        classifierModel: metadata.classifierModel ?? null,
        cost: metadata.cost ?? null,
        cacheHit: false,
        retried: false,
        details: {
          reason: getClassifierFailureReason(outcome.error),
          ...(metadata.failureStage ? { classifierFailureStage: metadata.failureStage } : {}),
          ...(metadata.schemaIssueSummary?.length
            ? { classifierSchemaIssueSummary: metadata.schemaIssueSummary }
            : {}),
          ...(metadata.topLevelKeys?.length
            ? { classifierOutputTopLevelKeys: metadata.topLevelKeys }
            : {}),
          ...formatError(outcome.error),
        },
      };
    }
  }
}

// Single sink for decision telemetry: one Analytics Engine data point and
// one `auto_routing_decision` log line per decision. Successes are sampled
// per the KV-configured rate; fallbacks and errors always log (at warn).
function recordDecision(
  env: Env,
  ctx: DecisionContext,
  durationMs: number,
  outcome: DecisionOutcome
): void {
  const summary = summarizeOutcome(outcome);

  writeClassifierMetricsDataPoint(env, {
    status: outcome.kind === 'error' ? classifierErrorStatus(outcome.error) : 'classified',
    classifierModel: summary.classifierModel,
    sessionId: ctx.sessionId,
    input: ctx.classifierInput,
    classification: summary.classification,
    classifierCostCredits: summary.cost,
    classifierDurationMs: durationMs,
    bodyBytes: ctx.bodyBytes,
    cacheHit: summary.cacheHit,
  });

  // Retried decisions are rare and diagnostically valuable, so they bypass
  // sampling along with failures.
  const isFailure = summary.status !== 'classified';
  const alwaysLog = isFailure || summary.retried;
  if (!alwaysLog && Math.random() >= ctx.successSampleRate) {
    return;
  }
  const log = isFailure ? console.warn : console.log;
  log(
    JSON.stringify({
      event: 'auto_routing_decision',
      status: summary.status,
      cacheHit: summary.cacheHit,
      retried: summary.retried,
      classifierModel: summary.classifierModel,
      requestedModel: ctx.classifierInput.requestedModel,
      apiKind: ctx.classifierInput.apiKind,
      sessionId: ctx.sessionId,
      hashExact: ctx.hashes.exact,
      hashLoose: ctx.hashes.loose,
      reqSeq: ctx.reqSeq,
      colo: ctx.colo,
      classifierDurationMs: Math.round(durationMs),
      classifierCostCredits: summary.cost,
      messageCount: ctx.classifierInput.messageCount,
      bodyBytes: ctx.bodyBytes,
      taskType: summary.classification?.taskType ?? null,
      subtaskType: summary.classification?.subtaskType ?? null,
      confidence: summary.classification?.confidence ?? null,
      hasMachineId: 'x-kilocode-machineid' in ctx.headers,
      hasClientRequestId: 'x-kilo-request' in ctx.headers,
      mode: ctx.headers['x-kilocode-mode'] ?? null,
      uaPrefix: ctx.headers['user-agent']?.slice(0, 40) ?? null,
      ...summary.details,
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

  const bodyBytes = textEncoder.encode(parsed.data.body).byteLength;
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
  const [hashes, classifierModel, successSampleRate] = await Promise.all([
    computeContentHashes(classifierInput.data),
    getClassifierModel(c.env),
    getDecisionLogSampleRate(c.env),
  ]);
  const ctx: DecisionContext = {
    classifierInput: classifierInput.data,
    sessionId: parsed.data.sessionId,
    headers: parsed.data.headers,
    hashes,
    conversationKey: deriveConversationKey(parsed.data.sessionId, hashes),
    reqSeq: isolateRequestSeq++,
    colo: (c.req.raw.cf?.colo as string | undefined) ?? null,
    bodyBytes,
    successSampleRate,
  };

  const cached = await getCachedClassification(
    c.env,
    ctx.conversationKey,
    hashes.exact,
    classifierModel
  );
  if (cached) {
    recordDecision(c.env, ctx, performance.now() - startedAt, {
      kind: 'cache_hit',
      classifierModel,
      classification: cached,
    });
    return c.json(decisionResponse(0, cached, classifierInput.data));
  }

  try {
    const classifier = await classifyNormalizedInput(c.env, classifierInput.data, classifierModel, {
      openrouterSessionId: ctx.conversationKey,
    });
    if (!classifier.fallback) {
      c.executionCtx.waitUntil(
        putCachedClassification(
          c.env,
          ctx.conversationKey,
          hashes.exact,
          classifier.classifierModel,
          classifier.classification
        )
      );
    }
    recordDecision(c.env, ctx, performance.now() - startedAt, { kind: 'model', classifier });
    // When routing decisions are implemented, include the prior decision for
    // this session as an input alongside classifier output.
    return c.json(
      decisionResponse(classifier.cost ?? 0, classifier.classification, classifierInput.data)
    );
  } catch (error) {
    recordDecision(c.env, ctx, performance.now() - startedAt, { kind: 'error', error });
    // A failed run can still have billed the first attempt (e.g. a valid-but-
    // invalid response followed by a throwing retry), so report that cost
    // even though there is no usable classifier result.
    return c.json(emptyDecisionResponse(getClassifierFailureMetadata(error).cost ?? 0));
  }
};
