import { MirrorPayloadSchema } from '@kilocode/auto-routing-contracts';
import type {
  AutoRoutingDecisionResponse,
  MirrorPayload,
  NormalizedClassifierInput,
  RouterDecision,
} from '@kilocode/auto-routing-contracts';
import { formatError } from '@kilocode/worker-utils';
import type { Handler } from 'hono';
import { writeClassifierMetricsDataPoint } from './classifier-analytics';
import type { ClassifierAnalyticsStatus } from './classifier-analytics';
import {
  getClassifierModel,
  getDecisionLogSampleRate,
  getMorphRouterEnabled,
} from './classifier-config';
import type { ClassifierOutput } from './classifier-output';
import {
  computeContentHashes,
  deriveConversationKey,
  deriveOutboundSessionId,
  hashIdentifierForTelemetry,
} from './conversation-identity';
import type { ContentHashes } from './conversation-identity';
import {
  getCachedClassification,
  getCachedRouterDecision,
  putCachedClassification,
  putCachedRouterDecision,
} from './decision-cache';
import { ClassifierRunError, classifyNormalizedInput } from './model-classifier';
import type { ClassifierRunResult } from './model-classifier';
import { MorphRouterError, routeWithMorphRouter, routerConfigFingerprint } from './morph-router';
import type { HonoEnv } from './hono-env';

// Isolate-scoped request counter, used to correlate latency with isolate
// warm-up in logs.
let isolateRequestSeq = 0;

function decisionResponse(
  cost: number,
  classification: ClassifierOutput,
  normalized: NormalizedClassifierInput,
  decision: RouterDecision | null
): AutoRoutingDecisionResponse {
  return {
    cost,
    decision,
    classifierResult: { classification, normalized },
  };
}

function emptyDecisionResponse(
  cost = 0,
  decision: RouterDecision | null = null
): AutoRoutingDecisionResponse {
  return {
    cost,
    decision,
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
// decision: the validated payload plus everything derived from it once.
type DecisionContext = {
  payload: MirrorPayload;
  hashes: ContentHashes;
  conversationKey: string;
  // One-way hash of the user id: anonymous ids embed the client IP, so logs
  // get a stable correlator instead of the raw value.
  userIdHash: string;
  reqSeq: number;
  colo: string | null;
  successSampleRate: number;
};

type DecisionOutcome =
  | { kind: 'cache_hit'; classifierModel: string; classification: ClassifierOutput }
  | { kind: 'model'; classifier: ClassifierRunResult }
  | { kind: 'error'; error: unknown };

type DecisionSummary = {
  status: ClassifierAnalyticsStatus;
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
    status: summary.status,
    classifierModel: summary.classifierModel,
    requestedModel: ctx.payload.input.requestedModel,
    classification: summary.classification,
    classifierCostCredits: summary.cost,
    classifierDurationMs: durationMs,
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
      requestedModel: ctx.payload.input.requestedModel,
      apiKind: ctx.payload.input.apiKind,
      sessionId: ctx.payload.sessionId,
      hashExact: ctx.hashes.exact,
      hashLoose: ctx.hashes.loose,
      reqSeq: ctx.reqSeq,
      colo: ctx.colo,
      classifierDurationMs: Math.round(durationMs),
      classifierCostCredits: summary.cost,
      messageCount: ctx.payload.input.messageCount,
      bodyBytes: ctx.payload.bodyBytes,
      taskType: summary.classification?.taskType ?? null,
      subtaskType: summary.classification?.subtaskType ?? null,
      confidence: summary.classification?.confidence ?? null,
      userIdHash: ctx.userIdHash,
      isAnonymousUser: ctx.payload.userId.startsWith('anon:'),
      clientRequestId: ctx.payload.clientRequestId,
      hasMachineId: ctx.payload.machineId !== null,
      mode: ctx.payload.mode,
      uaPrefix: ctx.payload.userAgent?.slice(0, 40) ?? null,
      ...summary.details,
    })
  );
}

type RouterDecisionStatus = 'routed' | `skipped:${string}` | `router_error:${string}`;

// Single sink for router telemetry, mirroring recordDecision: routed
// outcomes (including cache hits) and skips are sampled, errors always log
// at warn. Skips fire on every request of a tier with no routable
// candidates, so they share the success sample rate.
function recordRouterDecision(
  ctx: DecisionContext,
  durationMs: number,
  status: RouterDecisionStatus,
  decision: RouterDecision | null,
  cacheHit: boolean,
  details: Record<string, unknown>
): void {
  const isFailure = status.startsWith('router_error:');
  if (!isFailure && Math.random() >= ctx.successSampleRate) {
    return;
  }
  const log = isFailure ? console.warn : console.log;
  log(
    JSON.stringify({
      event: 'auto_routing_router_decision',
      status,
      cacheHit,
      autoModel: ctx.payload.routing?.autoModel ?? null,
      resolvedModel: ctx.payload.routing?.resolvedModel ?? null,
      routedModel: decision?.model ?? null,
      routerModel: decision?.routerModel ?? null,
      difficulty: decision?.difficulty ?? null,
      confidence: decision?.confidence ?? null,
      ambiguity: decision?.ambiguity ?? null,
      domain: decision?.domain ?? null,
      routerDurationMs: Math.round(durationMs),
      requestedModel: ctx.payload.input.requestedModel,
      apiKind: ctx.payload.input.apiKind,
      sessionId: ctx.payload.sessionId,
      clientRequestId: ctx.payload.clientRequestId,
      userIdHash: ctx.userIdHash,
      mode: ctx.payload.mode,
      reqSeq: ctx.reqSeq,
      colo: ctx.colo,
      ...details,
    })
  );
}

// Produces the Morph router decision for kilo-auto requests that carry
// routing context. Runs alongside classification and never throws: a router
// failure must not cost the caller a classification (or vice versa), so all
// failure modes collapse to a null decision plus telemetry.
async function resolveRouterDecision(
  env: Env,
  ctx: DecisionContext,
  waitUntil: (promise: Promise<unknown>) => void
): Promise<RouterDecision | null> {
  const routing = ctx.payload.routing;
  if (!routing) return null;
  if (!(await getMorphRouterEnabled(env))) return null;

  const startedAt = performance.now();
  const fingerprint = routerConfigFingerprint(routing);
  const cached = await getCachedRouterDecision(
    env,
    ctx.conversationKey,
    ctx.hashes.exact,
    fingerprint
  );
  if (cached) {
    recordRouterDecision(ctx, performance.now() - startedAt, 'routed', cached, true, {});
    return cached;
  }

  try {
    const outcome = await routeWithMorphRouter(env, routing, ctx.payload.input);
    if (outcome.kind === 'skipped') {
      recordRouterDecision(
        ctx,
        performance.now() - startedAt,
        `skipped:${outcome.reason}`,
        null,
        false,
        {}
      );
      return null;
    }
    waitUntil(
      putCachedRouterDecision(
        env,
        ctx.conversationKey,
        ctx.hashes.exact,
        fingerprint,
        outcome.decision
      )
    );
    recordRouterDecision(ctx, performance.now() - startedAt, 'routed', outcome.decision, false, {
      policy: outcome.policy,
      candidateCount: outcome.candidateCount,
    });
    return outcome.decision;
  } catch (error) {
    const status: RouterDecisionStatus =
      error instanceof MorphRouterError
        ? `router_error:${error.failureStage}`
        : 'router_error:unexpected_error';
    recordRouterDecision(
      ctx,
      performance.now() - startedAt,
      status,
      null,
      false,
      formatError(error)
    );
    return null;
  }
}

export const decideHandler: Handler<HonoEnv> = async c => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    writeClassifierMetricsDataPoint(c.env, { status: 'invalid_json' });
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsed = MirrorPayloadSchema.safeParse(rawBody);
  if (!parsed.success) {
    writeClassifierMetricsDataPoint(c.env, { status: 'invalid_envelope' });
    return c.json({ error: 'Invalid classifier payload' }, 400);
  }

  const payload = parsed.data;
  const startedAt = performance.now();
  const [hashes, userIdHash, classifierModel, successSampleRate] = await Promise.all([
    computeContentHashes(payload.input),
    hashIdentifierForTelemetry(payload.userId),
    getClassifierModel(c.env),
    getDecisionLogSampleRate(c.env),
  ]);
  const ctx: DecisionContext = {
    payload,
    hashes,
    conversationKey: deriveConversationKey(payload, hashes),
    userIdHash,
    reqSeq: isolateRequestSeq++,
    colo: (c.req.raw.cf?.colo as string | undefined) ?? null,
    successSampleRate,
  };

  // The router decision runs alongside the classification flow; both
  // resolve before the response so the gateway gets one combined result.
  const routerDecisionPromise = resolveRouterDecision(c.env, ctx, promise =>
    c.executionCtx.waitUntil(promise)
  );

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
    return c.json(decisionResponse(0, cached, payload.input, await routerDecisionPromise));
  }

  try {
    const classifier = await classifyNormalizedInput(c.env, payload.input, classifierModel, {
      openrouterSessionId: await deriveOutboundSessionId(ctx.conversationKey),
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
    return c.json(
      decisionResponse(
        classifier.cost ?? 0,
        classifier.classification,
        payload.input,
        await routerDecisionPromise
      )
    );
  } catch (error) {
    recordDecision(c.env, ctx, performance.now() - startedAt, { kind: 'error', error });
    // A failed run can still have billed the first attempt (e.g. a valid-but-
    // invalid response followed by a throwing retry), so report that cost
    // even though there is no usable classifier result. A router decision is
    // still useful without a classification, so it is returned regardless.
    return c.json(
      emptyDecisionResponse(
        getClassifierFailureMetadata(error).cost ?? 0,
        await routerDecisionPromise
      )
    );
  }
};
