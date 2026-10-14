import {
  ClassifierOutputSchema,
  MirrorPayloadSchema,
  DEFAULT_AUTO_ROUTER,
  poolEntryKey,
  taxonomyRouteKey,
  type AutoRoutingDecision,
  type AutoRoutingDecisionResponse,
  type EfficientModelPool,
  type MirrorPayload,
  type NormalizedClassifierInput,
  type RoutingConstraints,
  type RoutingTable,
} from '@kilocode/auto-routing-contracts';
import { formatError, ttlCached } from '@kilocode/worker-utils';
import type { Handler } from 'hono';
import { writeClassifierMetricsDataPoint } from './classifier-analytics';
import type { ClassifierAnalyticsStatus } from './classifier-analytics';
import { getClassifierModel, getDecisionLogSampleRate } from './classifier-config';
import type { ClassifierOutput } from '@kilocode/auto-routing-contracts/classifier';
import {
  computeContentHashes,
  deriveConversationKey,
  hashIdentifierForTelemetry,
} from './conversation-identity';
import type { ContentHashes } from './conversation-identity';
import {
  getHotCachedClassification,
  readConversationState,
  putCachedClassification,
  putStickyDecision,
} from './decision-cache';
import type { StickyDecision } from './decision-cache';
import { computeDecision, isLowConfidence, type DecisionIncumbent } from './decision-engine';
import { ClassifierRunError, classifyNormalizedInput } from './model-classifier';
import type { ClassifierRunResult } from './model-classifier';
import { fetchCustomRoutingTable } from './benchmark-origin';
import { getRoutingTable } from './routing-table';
import { getEffectiveAutoRoutingSettings } from './routing-mode';
import type { HonoEnv } from './hono-env';
import { getModelCapabilities } from './model-capabilities';
import type { ModelCapabilitiesMap } from './model-capabilities';
import { recordClassifierUsage, type ClassifierCallKind } from './classifier-usage';

const CUSTOM_ROUTING_TABLE_CACHE_TTL_MS = 60_000;

/** Ordered canonical key for an Efficient model pool (sort by poolEntryKey). */
export function orderedPoolCacheKey(pool: EfficientModelPool): string {
  return [...pool]
    .map(entry => poolEntryKey(entry))
    .sort()
    .join('\n');
}

// Per-pool-key isolate caches that close over the pool entries (~60s TTL).
const customTableLoaders = new Map<
  string,
  ReturnType<typeof ttlCached<Env, RoutingTable | null>>
>();

export function clearCustomRoutingTableCache(): void {
  for (const cache of customTableLoaders.values()) {
    cache.clear();
  }
  customTableLoaders.clear();
}

async function loadCustomRoutingTable(
  env: Env,
  pool: EfficientModelPool
): Promise<RoutingTable | null> {
  const key = orderedPoolCacheKey(pool);
  let cache = customTableLoaders.get(key);
  if (!cache) {
    const poolSnapshot = pool;
    cache = ttlCached(CUSTOM_ROUTING_TABLE_CACHE_TTL_MS, async (e: Env) => {
      return fetchCustomRoutingTable(e, poolSnapshot);
    });
    customTableLoaders.set(key, cache);
  }
  return cache.get(env).catch((error: unknown) => {
    console.warn(
      JSON.stringify({ event: 'auto_routing_custom_table_read_failed', ...formatError(error) })
    );
    return null;
  });
}

function stickyToIncumbent(sticky: StickyDecision | null): DecisionIncumbent | null {
  if (!sticky) return null;
  return { model: sticky.model, variant: sticky.variant ?? null };
}

function classificationFromRouteKey(routeKey: string): ClassifierOutput | null {
  const [taskType, subtaskType, extra] = routeKey.split('/');
  if (extra !== undefined) return null;
  const parsed = ClassifierOutputSchema.safeParse({
    taskType,
    subtaskType,
    contextComplexity: 'medium',
    reasoningComplexity: 'medium',
    riskLevel: 'low',
    executionMode: 'answer_only',
    requiresTools: false,
    confidence: 0,
  });
  return parsed.success ? parsed.data : null;
}

function decisionVariant(decision: AutoRoutingDecision): string | null {
  if (decision.variant !== undefined && decision.variant !== null) return decision.variant;
  // Legacy effort-only decisions: sticky stores null variant (model-only).
  return null;
}

// Isolate-scoped request counter, used to correlate latency with isolate
// warm-up in logs.
let isolateRequestSeq = 0;

function decisionResponse(
  classification: ClassifierOutput,
  normalized: NormalizedClassifierInput,
  decision: AutoRoutingDecision | null
): AutoRoutingDecisionResponse {
  return {
    cost: 0,
    decision,
    classifierResult: { classification, normalized },
  };
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
} {
  if (error instanceof ClassifierRunError) {
    return {
      cost: error.cost,
      classifierModel: error.classifierModel,
      failureStage: error.failureStage,
      schemaIssueSummary: error.schemaIssueSummary,
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
    return `classifier_error:${error.failureStage}`;
  }
  if (error instanceof Error && error.message.startsWith('Secrets Worker:')) {
    return 'classifier_error:secret_error';
  }
  return 'classifier_error:unexpected_error';
}

// Per-request fields shared by every metrics write and log line for the
// decision: the validated payload plus everything derived from it once.
type DecisionTimings = {
  settingsMs: number;
  capabilitiesMs: number | null;
  tableMs: number | null;
  prepMs: number;
  cacheReadMs: number;
  classifierMs: number | null;
  totalMs: number;
};

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
  timings: DecisionTimings;
};

type ClassifierOutcome =
  | { kind: 'model'; classifier: ClassifierRunResult }
  | { kind: 'error'; error: unknown };

type ClassificationRun = {
  promise: Promise<ClassifierOutcome>;
  outcome: ClassifierOutcome | null;
};

type DecisionOutcome =
  | { kind: 'cache_hit'; classifierModel: string; classification: ClassifierOutput }
  | ClassifierOutcome;

function classifierOutcomeCost(outcome: ClassifierOutcome): number {
  return outcome.kind === 'model'
    ? (outcome.classifier.cost ?? 0)
    : (getClassifierFailureMetadata(outcome.error).cost ?? 0);
}

type DecisionSummary = {
  status: ClassifierAnalyticsStatus;
  classifierModel: string | null;
  classification?: ClassifierOutput;
  cost: number | null;
  cacheHit: boolean;
  // Outcome-specific log fields (failure diagnostics).
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
        details: {},
      };
    case 'model': {
      const { classifier } = outcome;
      return {
        status: 'classified',
        classifierModel: classifier.classifierModel,
        classification: classifier.classification,
        cost: classifier.cost,
        cacheHit: false,
        details: {},
      };
    }
    case 'error': {
      const metadata = getClassifierFailureMetadata(outcome.error);
      return {
        status: classifierErrorStatus(outcome.error),
        classifierModel: metadata.classifierModel ?? null,
        cost: metadata.cost ?? null,
        cacheHit: false,
        details: {
          reason: getClassifierFailureReason(outcome.error),
          ...(metadata.failureStage ? { classifierFailureStage: metadata.failureStage } : {}),
          ...(metadata.schemaIssueSummary?.length
            ? { classifierSchemaIssueSummary: metadata.schemaIssueSummary }
            : {}),
          ...formatError(outcome.error),
        },
      };
    }
  }
}

function recordDecision(
  env: Env,
  ctx: DecisionContext,
  durationMs: number,
  outcome: DecisionOutcome,
  autoRoutingMode: string,
  decision: AutoRoutingDecision | null = null,
  incumbent: StickyDecision | null = null,
  classification: 'sync' | 'speculative' | 'cache' | 'background' = outcome.kind === 'cache_hit'
    ? 'cache'
    : 'sync',
  lowConfidence = false,
  speculativeCost?: number
): void {
  const summary = summarizeOutcome(outcome);
  if (speculativeCost !== undefined) summary.cost = speculativeCost;
  summary.details.timings = { ...ctx.timings, totalMs: durationMs };

  writeClassifierMetricsDataPoint(env, {
    status: summary.status,
    classifierModel: summary.classifierModel,
    requestedModel: ctx.payload.input.requestedModel,
    classification: summary.classification,
    classifierCostCredits: summary.cost,
    classifierDurationMs: durationMs,
    cacheHit: summary.cacheHit,
  });

  const incumbentModel = incumbent?.model ?? null;
  const decidedVariant = decision?.variant ?? null;
  const switched =
    decision !== null &&
    incumbentModel !== null &&
    (decision.model !== incumbentModel ||
      (incumbent?.variant != null && decidedVariant !== incumbent.variant));
  const routeKey = summary.classification ? taxonomyRouteKey(summary.classification) : null;
  // Null when there is no incumbent route to compare against (no incumbent,
  // a pre-routeKey cache entry, or no classification this request).
  const routeChanged =
    routeKey !== null && incumbent?.routeKey != null ? routeKey !== incumbent.routeKey : null;

  const isFailure = summary.status !== 'classified';
  const paidSpeculation =
    (classification === 'speculative' || speculativeCost !== undefined) && (summary.cost ?? 0) > 0;
  const alwaysLog = isFailure || switched || paidSpeculation;
  if (!alwaysLog && Math.random() >= ctx.successSampleRate) {
    return;
  }
  const log = isFailure ? console.warn : console.log;
  log(
    JSON.stringify({
      event: 'auto_routing_decision',
      status: summary.status,
      cacheHit: summary.cacheHit,
      classifierModel: summary.classifierModel,
      requestedModel: ctx.payload.input.requestedModel,
      apiKind: ctx.payload.input.apiKind,
      sessionId: ctx.payload.sessionId,
      hashExact: ctx.hashes.exact,
      hashLoose: ctx.hashes.loose,
      reqSeq: ctx.reqSeq,
      colo: ctx.colo,
      router: ctx.payload.router ?? DEFAULT_AUTO_ROUTER,
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
      autoRoutingMode,
      uaPrefix: ctx.payload.userAgent?.slice(0, 40) ?? null,
      decidedModel: decision?.model ?? null,
      decidedVariant,
      decidedTaskType: decision?.taskType ?? null,
      decidedSubtaskType: decision?.subtaskType ?? null,
      decisionSource: decision?.source ?? null,
      classification,
      ...(lowConfidence && decision ? { lowConfidence: true } : {}),
      sticky: decision?.sticky ?? null,
      incumbentModel,
      switched,
      switchReason: decision?.switchReason ?? null,
      routeChanged,
      contextTokens: ctx.payload.constraints?.promptTokensEstimate ?? null,
      // False when this line bypassed the success sample rate (switch,
      // retry, failure); downstream rate math must only scale sampled rows.
      sampled: !alwaysLog,
      ...summary.details,
    })
  );
}

export const decideHandler: Handler<HonoEnv> = async c => {
  const generation = Date.now();
  const requestStart = `${generation}:${performance.now()}`;
  const usageCreatedAt = new Date(generation).toISOString();
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
  const router = payload.router ?? DEFAULT_AUTO_ROUTER;
  const startedAt = performance.now();
  const timings: DecisionTimings = {
    settingsMs: 0,
    capabilitiesMs: null,
    tableMs: null,
    prepMs: 0,
    cacheReadMs: 0,
    classifierMs: null,
    totalMs: 0,
  };
  const deniedModelIds = new Set(payload.routingPolicy?.deniedModelIds ?? []);
  const hasConstraints = payload.constraints !== undefined;
  const constraints: RoutingConstraints | undefined = payload.constraints;

  const routingPrerequisites = (async () => {
    // Resolve settings before the single capability load so custom-pool
    // model ids are included. Classification does not depend on either.
    const settingsStartedAt = performance.now();
    const effectiveSettings = await getEffectiveAutoRoutingSettings(c.env, {
      userId: payload.userId,
      organizationId: payload.organizationId,
    });
    timings.settingsMs = performance.now() - settingsStartedAt;
    const configuredPool = router === 'efficient' ? effectiveSettings.pool : null;
    let capabilities: ModelCapabilitiesMap = new Map();
    if (hasConstraints || configuredPool !== null) {
      const capabilitiesStartedAt = performance.now();
      capabilities = await getModelCapabilities(c.env, {
        router,
        waitUntil: promise => c.executionCtx.waitUntil(promise),
        ...(configuredPool !== null
          ? { additionalModelIds: configuredPool.map(entry => entry.model) }
          : {}),
      });
      timings.capabilitiesMs = performance.now() - capabilitiesStartedAt;
    }

    const tableStartedAt = performance.now();
    const routingTable = await (configuredPool === null
      ? getRoutingTable(c.env, router)
      : loadCustomRoutingTable(c.env, configuredPool));
    timings.tableMs = performance.now() - tableStartedAt;
    return {
      configuredPool,
      routingMode: effectiveSettings.mode,
      capabilities,
      routingTable,
    };
  })();
  const classifyAndBill = async (
    ctx: DecisionContext,
    classifierModel: string,
    kind: ClassifierCallKind
  ): Promise<ClassifierRunResult> => {
    const identity = {
      conversationKey: ctx.conversationKey,
      classifierModel,
      contentHash: ctx.hashes.exact,
      kind,
      requestStart,
    };
    try {
      const classifier = await classifyNormalizedInput(c.env, payload.input, classifierModel);
      c.executionCtx.waitUntil(
        recordClassifierUsage(c.env, payload, identity, classifier.cost, usageCreatedAt)
      );
      return classifier;
    } catch (error) {
      c.executionCtx.waitUntil(
        recordClassifierUsage(
          c.env,
          payload,
          identity,
          getClassifierFailureMetadata(error).cost,
          usageCreatedAt
        )
      );
      throw error;
    }
  };

  const preparedClassification = (async (): Promise<{
    ctx: DecisionContext;
    sticky: StickyDecision | null;
    speculative: ClassificationRun | null;
    outcome:
      | DecisionOutcome
      | { kind: 'sticky_immediate'; classifierModel: string; decision: AutoRoutingDecision };
  }> => {
    const prepStartedAt = performance.now();
    const [hashes, userIdHash, classifierModel, successSampleRate] = await Promise.all([
      computeContentHashes(payload.input),
      hashIdentifierForTelemetry(payload.userId),
      getClassifierModel(c.env),
      getDecisionLogSampleRate(c.env),
    ]);
    timings.prepMs = performance.now() - prepStartedAt;
    const ctx: DecisionContext = {
      payload,
      hashes,
      conversationKey: deriveConversationKey(payload, hashes),
      userIdHash,
      reqSeq: isolateRequestSeq++,
      colo: (c.req.raw.cf?.colo as string | undefined) ?? null,
      successSampleRate,
      timings,
    };
    const runClassifier = async (kind: ClassifierCallKind): Promise<ClassifierOutcome> => {
      const classifierStartedAt = performance.now();
      try {
        const classifier = await classifyAndBill(ctx, classifierModel, kind);
        return { kind: 'model', classifier };
      } catch (error) {
        return { kind: 'error', error };
      } finally {
        timings.classifierMs = performance.now() - classifierStartedAt;
      }
    };
    const speculative: ClassificationRun | null =
      (payload.input.messageCount === null || payload.input.messageCount <= 2) &&
      !getHotCachedClassification(hashes.exact, classifierModel, router)
        ? { promise: runClassifier('speculative'), outcome: null }
        : null;
    if (speculative) {
      speculative.promise = speculative.promise.then(outcome => {
        speculative.outcome = outcome;
        return outcome;
      });
      c.executionCtx.waitUntil(speculative.promise);
    }
    const cacheReadStartedAt = performance.now();
    const { classification: cached, sticky } = await readConversationState(
      c.env,
      ctx.conversationKey,
      hashes.exact,
      classifierModel,
      router
    );
    timings.cacheReadMs = performance.now() - cacheReadStartedAt;
    if (cached) {
      return {
        ctx,
        sticky,
        speculative,
        outcome: { kind: 'cache_hit', classifierModel, classification: cached },
      };
    }
    if (sticky?.routeKey != null) {
      const classification = classificationFromRouteKey(sticky.routeKey);
      if (classification) {
        const routing = await routingPrerequisites;
        const decision = computeDecision(
          classification,
          routing.routingTable,
          stickyToIncumbent(sticky),
          deniedModelIds,
          routing.routingMode,
          {
            preserveIncumbentVariant: true,
            constraints,
            contextTokens: payload.constraints?.promptTokensEstimate,
            capabilityMap:
              hasConstraints || routing.configuredPool !== null ? routing.capabilities : undefined,
            failClosedOnInactive: routing.configuredPool !== null,
          }
        );
        if (
          decision?.model === sticky.model &&
          (sticky.variant === null || decisionVariant(decision) === sticky.variant)
        ) {
          return {
            ctx,
            sticky,
            speculative,
            outcome: { kind: 'sticky_immediate', classifierModel, decision },
          };
        }
      }
    }

    const outcome = await (speculative?.promise ?? runClassifier('sync'));
    return { ctx, sticky, speculative, outcome };
  })();
  // Keep an in-flight paid call alive if the gateway disconnects before its response.
  c.executionCtx.waitUntil(
    preparedClassification.then(
      () => undefined,
      () => undefined
    )
  );

  const [routing, prepared] = await Promise.all([routingPrerequisites, preparedClassification]);
  const { configuredPool, routingMode, capabilities, routingTable } = routing;
  const { ctx, sticky, speculative, outcome } = prepared;
  const incumbent = stickyToIncumbent(sticky);
  const decisionOptions = {
    constraints: payload.constraints,
    contextTokens: payload.constraints?.promptTokensEstimate,
    capabilityMap: hasConstraints || configuredPool !== null ? capabilities : undefined,
    failClosedOnInactive: configuredPool !== null,
  };
  if (outcome.kind === 'sticky_immediate') {
    const responseDurationMs = performance.now() - startedAt;
    const backgroundCtx = { ...ctx, timings: { ...timings, totalMs: responseDurationMs } };
    c.executionCtx.waitUntil(
      (async () => {
        const classifierStartedAt = performance.now();
        try {
          const speculativeOutcome = speculative ? await speculative.promise : null;
          if (speculativeOutcome?.kind === 'error') throw speculativeOutcome.error;
          const classifier =
            speculativeOutcome?.kind === 'model'
              ? speculativeOutcome.classifier
              : await classifyAndBill(ctx, outcome.classifierModel, 'background');
          backgroundCtx.timings.classifierMs = speculative
            ? timings.classifierMs
            : performance.now() - classifierStartedAt;
          const decision = computeDecision(
            classifier.classification,
            routingTable,
            incumbent,
            deniedModelIds,
            routingMode,
            { ...decisionOptions, confidence: classifier.classification.confidence }
          );
          await Promise.all([
            putCachedClassification(
              c.env,
              ctx.conversationKey,
              ctx.hashes.exact,
              classifier.classifierModel,
              classifier.classification,
              router
            ),
            decision
              ? putStickyDecision(
                  c.env,
                  ctx.conversationKey,
                  decision.model,
                  decisionVariant(decision),
                  taxonomyRouteKey(classifier.classification),
                  generation,
                  router
                )
              : Promise.resolve(),
          ]);
          recordDecision(
            c.env,
            backgroundCtx,
            responseDurationMs,
            { kind: 'model', classifier },
            routingMode,
            decision,
            sticky,
            'background',
            isLowConfidence(routingTable, classifier.classification.confidence),
            speculative ? (classifier.cost ?? 0) : undefined
          );
        } catch (error) {
          if (speculative) {
            backgroundCtx.timings.classifierMs = timings.classifierMs;
            recordDecision(
              c.env,
              backgroundCtx,
              responseDurationMs,
              { kind: 'error', error },
              routingMode,
              outcome.decision,
              sticky,
              'background',
              false,
              getClassifierFailureMetadata(error).cost ?? 0
            );
          }
          console.warn(
            JSON.stringify({
              event: 'auto_routing_background_classify_failed',
              hashExact: ctx.hashes.exact,
              classifierModel: outcome.classifierModel,
              ...formatError(error),
            })
          );
        }
      })()
    );
    return c.json({ cost: 0, decision: outcome.decision, classifierResult: null });
  }
  if (outcome.kind === 'cache_hit') {
    const cached = outcome.classification;
    const decision = computeDecision(cached, routingTable, incumbent, deniedModelIds, routingMode, {
      ...decisionOptions,
      confidence: cached.confidence,
    });
    if (decision) {
      c.executionCtx.waitUntil(
        putStickyDecision(
          c.env,
          ctx.conversationKey,
          decision.model,
          decisionVariant(decision),
          taxonomyRouteKey(cached),
          generation,
          router
        )
      );
    }
    const responseDurationMs = performance.now() - startedAt;
    if (speculative && !speculative.outcome) {
      c.executionCtx.waitUntil(
        speculative.promise.then(result => {
          recordDecision(
            c.env,
            ctx,
            responseDurationMs,
            outcome,
            routingMode,
            decision,
            sticky,
            'cache',
            isLowConfidence(routingTable, cached.confidence),
            classifierOutcomeCost(result)
          );
        })
      );
    } else {
      recordDecision(
        c.env,
        ctx,
        responseDurationMs,
        outcome,
        routingMode,
        decision,
        sticky,
        'cache',
        isLowConfidence(routingTable, cached.confidence),
        speculative?.outcome ? classifierOutcomeCost(speculative.outcome) : undefined
      );
    }
    return c.json(decisionResponse(cached, payload.input, decision));
  }

  try {
    if (outcome.kind === 'error') throw outcome.error;
    const classifier = outcome.classifier;
    c.executionCtx.waitUntil(
      putCachedClassification(
        c.env,
        ctx.conversationKey,
        ctx.hashes.exact,
        classifier.classifierModel,
        classifier.classification,
        router
      )
    );
    const decision = computeDecision(
      classifier.classification,
      routingTable,
      incumbent,
      deniedModelIds,
      routingMode,
      { ...decisionOptions, confidence: classifier.classification.confidence }
    );
    if (decision) {
      c.executionCtx.waitUntil(
        putStickyDecision(
          c.env,
          ctx.conversationKey,
          decision.model,
          decisionVariant(decision),
          taxonomyRouteKey(classifier.classification),
          generation,
          router
        )
      );
    }
    recordDecision(
      c.env,
      ctx,
      performance.now() - startedAt,
      { kind: 'model', classifier },
      routingMode,
      decision,
      sticky,
      speculative ? 'speculative' : 'sync',
      isLowConfidence(routingTable, classifier.classification.confidence)
    );
    return c.json(decisionResponse(classifier.classification, payload.input, decision));
  } catch (error) {
    recordDecision(
      c.env,
      ctx,
      performance.now() - startedAt,
      { kind: 'error', error },
      routingMode,
      null,
      sticky,
      speculative ? 'speculative' : 'sync'
    );
    return c.json(emptyDecisionResponse());
  }
};
