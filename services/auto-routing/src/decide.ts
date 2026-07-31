import {
  MirrorPayloadSchema,
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
  deriveOutboundSessionId,
  hashIdentifierForTelemetry,
} from './conversation-identity';
import type { ContentHashes } from './conversation-identity';
import {
  getCachedClassification,
  getStickyDecision,
  putCachedClassification,
  putStickyDecision,
} from './decision-cache';
import type { StickyDecision } from './decision-cache';
import {
  computeDecision,
  modelSatisfiesConstraints,
  type DecisionIncumbent,
} from './decision-engine';
import { ClassifierRunError, classifyNormalizedInput } from './model-classifier';
import type { ClassifierRunResult } from './model-classifier';
import { fetchCustomRoutingTable } from './benchmark-origin';
import { getRoutingTable } from './routing-table';
import { getEffectiveAutoRoutingSettings } from './routing-mode';
import type { HonoEnv } from './hono-env';
import { codingPlanDefaultDecision, getCodingPlanPreference } from './coding-plan-preference';
import { getModelCapabilities } from './model-capabilities';
import type { ModelCapabilitiesMap } from './model-capabilities';

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

function decisionVariant(decision: AutoRoutingDecision): string | null {
  if (decision.source !== 'benchmark') return null;
  if (decision.variant !== undefined && decision.variant !== null) return decision.variant;
  // Legacy effort-only decisions: sticky stores null variant (model-only).
  return null;
}

// Isolate-scoped request counter, used to correlate latency with isolate
// warm-up in logs.
let isolateRequestSeq = 0;

function decisionResponse(
  cost: number,
  classification: ClassifierOutput,
  normalized: NormalizedClassifierInput,
  decision: AutoRoutingDecision | null
): AutoRoutingDecisionResponse {
  return {
    cost,
    decision,
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
// per the KV-configured rate; fallbacks, errors, and real model switches
// always log (failures at warn).
function recordDecision(
  env: Env,
  ctx: DecisionContext,
  durationMs: number,
  outcome: DecisionOutcome,
  autoRoutingMode: string,
  decision: AutoRoutingDecision | null = null,
  incumbent: StickyDecision | null = null
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

  const incumbentModel = incumbent?.model ?? null;
  const decidedVariant =
    decision !== null && decision.source === 'benchmark' ? (decision.variant ?? null) : null;
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

  // Retried decisions are rare and diagnostically valuable, so they bypass
  // sampling along with failures. Real model switches also always log:
  // within-session switch sequences are the signal the sampled stream
  // decimates.
  const isFailure = summary.status !== 'classified';
  const alwaysLog = isFailure || summary.retried || switched;
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
      autoRoutingMode,
      uaPrefix: ctx.payload.userAgent?.slice(0, 40) ?? null,
      decidedModel: decision?.model ?? null,
      decidedVariant,
      decidedTaskType: decision?.taskType ?? null,
      decidedSubtaskType: decision?.subtaskType ?? null,
      decisionSource: decision?.source ?? null,
      sticky: decision?.sticky ?? null,
      incumbentModel,
      switched,
      switchReason: decision?.source === 'benchmark' ? (decision.switchReason ?? null) : null,
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
  const deniedModelIds = new Set(payload.routingPolicy?.deniedModelIds ?? []);
  const codingPlanPreference = await getCodingPlanPreference(c.env, payload.userId);
  const codingPlanActive =
    codingPlanPreference.active && !deniedModelIds.has(codingPlanPreference.modelId);
  // Narrow once: `constraints` is only non-undefined inside the branches
  // that already checked `hasConstraints`. This avoids a `!` non-null
  // assertion across the closure.
  const hasConstraints = payload.constraints !== undefined;
  const constraints: RoutingConstraints | undefined = payload.constraints;

  // Constraints-absent coding-plan short-circuit stays byte-identical: no
  // settings hop, capability fetch, routing-table fetch, or benchmark hop.
  if (codingPlanActive && !hasConstraints) {
    const decision = codingPlanDefaultDecision(codingPlanPreference);
    writeClassifierMetricsDataPoint(c.env, {
      status: 'coding_plan_default',
      classifierModel: 'coding_plan_default',
      requestedModel: payload.input.requestedModel,
      classifierDurationMs: performance.now() - startedAt,
      classifierCostCredits: 0,
      cacheHit: false,
    });
    return c.json({ cost: 0, decision, classifierResult: null });
  }

  // Resolve settings before the (single) capability load so custom-pool
  // model ids are included when a pool is configured. Settings do not
  // depend on capabilities. Null pool keeps platform-table semantics and
  // does not add a custom benchmark hop beyond the table loader below.
  const effectiveSettings = await getEffectiveAutoRoutingSettings(c.env, {
    userId: payload.userId,
    organizationId: payload.organizationId,
  });
  const configuredPool = effectiveSettings.pool;
  const routingMode = effectiveSettings.mode;
  const failClosedOnInactive = configuredPool !== null;

  // One capability load on the decide path. Include pool model ids whenever
  // a pool is configured so constrained + custom-pool traffic does not pay
  // two sequential 500ms capability budgets.
  let capabilities: ModelCapabilitiesMap = new Map();
  if (hasConstraints || configuredPool !== null) {
    capabilities = await getModelCapabilities(c.env, {
      codingPlanModelId: codingPlanActive ? codingPlanPreference.modelId : null,
      ...(configuredPool !== null
        ? { additionalModelIds: configuredPool.map(entry => entry.model) }
        : {}),
    });
  }

  if (codingPlanActive && hasConstraints && constraints) {
    const canTakeShortCircuit = modelSatisfiesConstraints(
      capabilities.get(codingPlanPreference.modelId),
      constraints
    );
    if (canTakeShortCircuit) {
      const decision = codingPlanDefaultDecision(codingPlanPreference);
      writeClassifierMetricsDataPoint(c.env, {
        status: 'coding_plan_default',
        classifierModel: 'coding_plan_default',
        requestedModel: payload.input.requestedModel,
        classifierDurationMs: performance.now() - startedAt,
        classifierCostCredits: 0,
        cacheHit: false,
      });
      return c.json({ cost: 0, decision, classifierResult: null });
    }
    // Fall through to the normal benchmark flow because the coding-plan
    // model cannot satisfy the constrained request. This moves the request
    // from subscription-billed to credit-billed benchmark routing.
  }

  // Null pool uses the platform cached table (no custom benchmark hop).
  // Configured pool loads the sparse custom table for exactly those entries;
  // on lookup failure the table is null → null decision → gateway balanced fallback.
  const [hashes, userIdHash, classifierModel, successSampleRate, routingTable] = await Promise.all([
    computeContentHashes(payload.input),
    hashIdentifierForTelemetry(payload.userId),
    getClassifierModel(c.env),
    getDecisionLogSampleRate(c.env),
    configuredPool === null
      ? getRoutingTable(c.env)
      : loadCustomRoutingTable(c.env, configuredPool),
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

  // Both live in the conversation's Durable Object; fetch them together.
  const [cached, sticky] = await Promise.all([
    getCachedClassification(c.env, ctx.conversationKey, hashes.exact, classifierModel),
    getStickyDecision(c.env, ctx.conversationKey),
  ]);
  const incumbent = stickyToIncumbent(sticky);
  const decisionOptions = {
    constraints: payload.constraints,
    capabilityMap: hasConstraints || configuredPool !== null ? capabilities : undefined,
    failClosedOnInactive,
  };
  if (cached) {
    const decision = computeDecision(
      cached,
      routingTable,
      incumbent,
      deniedModelIds,
      routingMode,
      decisionOptions
    );
    if (decision) {
      c.executionCtx.waitUntil(
        putStickyDecision(
          c.env,
          ctx.conversationKey,
          decision.model,
          decisionVariant(decision),
          taxonomyRouteKey(cached)
        )
      );
    }
    recordDecision(
      c.env,
      ctx,
      performance.now() - startedAt,
      { kind: 'cache_hit', classifierModel, classification: cached },
      routingMode,
      decision,
      sticky
    );
    return c.json(decisionResponse(0, cached, payload.input, decision));
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
    const decision = computeDecision(
      classifier.classification,
      routingTable,
      incumbent,
      deniedModelIds,
      routingMode,
      decisionOptions
    );
    // Like the classification cache, sticky state only trusts real classifier
    // output: a heuristic fallback must not re-anchor the session's model.
    if (decision && !classifier.fallback) {
      c.executionCtx.waitUntil(
        putStickyDecision(
          c.env,
          ctx.conversationKey,
          decision.model,
          decisionVariant(decision),
          taxonomyRouteKey(classifier.classification)
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
      sticky
    );
    return c.json(
      decisionResponse(classifier.cost ?? 0, classifier.classification, payload.input, decision)
    );
  } catch (error) {
    recordDecision(
      c.env,
      ctx,
      performance.now() - startedAt,
      { kind: 'error', error },
      routingMode,
      null,
      sticky
    );
    // A failed run can still have billed the first attempt (e.g. a valid-but-
    // invalid response followed by a throwing retry), so report that cost
    // even though there is no usable classifier result.
    return c.json(emptyDecisionResponse(getClassifierFailureMetadata(error).cost ?? 0));
  }
};
