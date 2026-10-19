import {
  CUSTOM_ROUTER_ERROR_HTTP_STATUS,
  CUSTOM_ROUTER_EVAL_CASE_PATH,
  CUSTOM_ROUTER_EVAL_PLAN_PATH,
  CUSTOM_ROUTER_EVAL_RESULT_PATH,
  InternalClientEvalCaseRequestSchema,
  InternalClientEvalPlanRequestSchema,
  InternalClientEvalResultRequestSchema,
  customRouterEntryKey,
  customRouterEntryRef,
  taxonomyRouteKey,
  type AutoRouter,
  type BenchmarkConfig,
  type ClientEvalBilling,
  type ClientEvalCaseResponse,
  type ClientEvalPair,
  type ClientEvalPlanItem,
  type ClientEvalPlanResponse,
  type ClientEvalResultResponse,
  type CustomRouterErrorCode,
  type CustomRouterErrorResponse,
  type InternalClientEvalCaseRequest,
  type InternalClientEvalPlanRequest,
  type InternalClientEvalResultRequest,
} from '@kilocode/auto-routing-contracts';
import type { UsageRecordRequest } from '@kilocode/usage-contracts';
import { formatError } from '@kilocode/worker-utils';
import type { UsageWriteOutcome } from '@kilocode/worker-utils/usage-writer-client';
import type { Hono } from 'hono';
import type * as z from 'zod';
import { DECIDER_CLI_TIMEOUT_MS, deciderCliPrompt } from './cli-runner';
import {
  clientCaseKey,
  clientPairKey,
  deleteClientCaseUpload,
  ensureClientProfile,
  getClientCase,
  groupClientProfilesByPair,
  isCurrentClientProfile,
  listClientCaseKeys,
  listOwnerClientProfiles,
  refreshClientProfileRollup,
  saveClientCaseResult,
} from './client-profiles';
import { getBenchmarkConfig } from './config';
import {
  newestReadyMeasurement,
  resolveCustomRouterEntries,
  type CatalogSource,
} from './custom-routers';
import { createDeciderJudge, DECIDER_JUDGE_MODEL, deciderJudgeRequest } from './decider-judge';
import { buildGraderUsage, writeGraderUsage } from './grader-usage';
import { gradeDeciderOutput, type DeciderJudge } from './grading';
import type { HonoEnv } from './hono-env';
import { admitJudgeInference, type JudgeAdmission } from './judge-admission';
import { createSystemOneClient } from './openrouter';
import { currentProfileContextFromConfig } from './profiles';
import { deciderCasesForRouter } from './run';

export class ClientEvalError extends Error {
  constructor(
    readonly code: CustomRouterErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ClientEvalError';
  }
}

export type ClientEvalDeps = {
  source: CatalogSource;
  admitJudge: (
    billing: ClientEvalBilling,
    request: { model: string; body: unknown }
  ) => Promise<JudgeAdmission>;
  createJudge: () => Promise<DeciderJudge>;
  writeUsage: (usage: UsageRecordRequest) => Promise<UsageWriteOutcome>;
  now?: () => Date;
};

function findCase(router: AutoRouter, caseId: string) {
  const benchCase = deciderCasesForRouter(router).find(c => c.id === caseId);
  if (!benchCase) {
    throw new ClientEvalError('invalid_request', `Unknown ${router} case: ${caseId}`);
  }
  return benchCase;
}

/** Every (entry, variant, case, rep) the owner's CLI has not uploaded under the current engine. */
export async function planClientEval(
  db: D1Database,
  config: BenchmarkConfig,
  request: InternalClientEvalPlanRequest,
  source: CatalogSource
): Promise<ClientEvalPlanResponse> {
  const current = currentProfileContextFromConfig(config);
  const clientEval = new Set(request.clientEvalEntryKeys);
  const { resolved } = await resolveCustomRouterEntries(
    request.entries.filter(entry => clientEval.has(customRouterEntryKey(entry))),
    request.clientEvalEntryKeys,
    source
  );
  const profiles = groupClientProfilesByPair(
    await listOwnerClientProfiles(db, request, request.baseRouter)
  );
  const pairs = resolved.flatMap(item =>
    item.measuredBy === 'client'
      ? item.variants.map(variant => {
          const entry = customRouterEntryRef(item.entry);
          return { entry, variant, rows: profiles.get(clientPairKey(entry, variant)) ?? [] };
        })
      : []
  );
  const currentProfileIds = new Map(
    pairs.flatMap(pair => {
      const row = pair.rows.find(r => isCurrentClientProfile(r, current));
      return row ? [[clientPairKey(pair.entry, pair.variant), row.id] as const] : [];
    })
  );
  const uploaded = await listClientCaseKeys(db, [...currentProfileIds.values()]);
  const cases = deciderCasesForRouter(request.baseRouter);
  const items: ClientEvalPlanItem[] = [];
  const staleEntries: ClientEvalPair[] = [];
  for (const { entry, variant, rows } of pairs) {
    const profileId = currentProfileIds.get(clientPairKey(entry, variant));
    const done = profileId ? uploaded.get(profileId) : undefined;
    for (let rep = 0; rep < current.repetitions; rep++) {
      for (const benchCase of cases) {
        if (!done?.has(clientCaseKey(benchCase.id, rep))) {
          items.push({ entry, variant, caseId: benchCase.id, rep });
        }
      }
    }
    const served = newestReadyMeasurement(
      rows,
      row => isCurrentClientProfile(row, current),
      row => row.updated_at,
      row => row.results >= cases.length * current.repetitions
    );
    if (served?.stale) staleEntries.push({ entry, variant });
  }
  return {
    baseRouter: request.baseRouter,
    engineIdentity: current.engineIdentity,
    repetitions: current.repetitions,
    items,
    staleEntries,
  };
}

/** The prompt exactly as the platform container sends it; golden answers stay here. */
export function clientEvalCase(request: InternalClientEvalCaseRequest): ClientEvalCaseResponse {
  return {
    caseId: request.caseId,
    baseRouter: request.baseRouter,
    prompt: deciderCliPrompt(findCase(request.baseRouter, request.caseId)),
    timeoutMs: DECIDER_CLI_TIMEOUT_MS,
  };
}

// D1 caps one value at 2 MB; three UTF-8 bytes per UTF-16 unit keeps the stored output well
// below it. The output is kept for diagnostics; grading uses the full upload.
const STORED_OUTPUT_MAX_LENGTH = 200_000;

/**
 * Grade one uploaded case with the platform graders and roll it into the owner's
 * client profile. The graded case is stored before judged grading is billed to the
 * paying owner, and removed again when billing fails, so a retry never bills twice for
 * one stored case. A case that already ran returns its stored score; one that did not
 * (nonzero exit or timeout) is replaced by the new upload.
 */
export async function gradeClientEvalResult(
  db: D1Database,
  config: BenchmarkConfig,
  request: InternalClientEvalResultRequest,
  deps: ClientEvalDeps
): Promise<ClientEvalResultResponse> {
  const current = currentProfileContextFromConfig(config);
  if (request.engineIdentity !== current.engineIdentity) {
    throw new ClientEvalError(
      'stale_engine_identity',
      `The benchmark engine changed to ${current.engineIdentity}; request a new plan.`
    );
  }
  const benchCase = findCase(request.baseRouter, request.caseId);
  if (request.rep >= current.repetitions) {
    throw new ClientEvalError(
      'invalid_request',
      `rep must be below the base router's ${current.repetitions} repetitions`
    );
  }
  const entryKey = customRouterEntryKey(request.entry);
  const entry = request.entries.find(candidate => customRouterEntryKey(candidate) === entryKey);
  const { resolved } = entry
    ? await resolveCustomRouterEntries([entry], request.clientEvalEntryKeys, deps.source)
    : { resolved: [] };
  const [item] = resolved;
  if (item?.measuredBy !== 'client' || !item.variants.includes(request.variant)) {
    throw new ClientEvalError('invalid_request', `Unknown variant for ${entryKey}`);
  }

  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const profile = await ensureClientProfile(
    db,
    {
      ownerType: request.ownerType,
      ownerId: request.ownerId,
      router: request.baseRouter,
      entry: request.entry,
      variant: request.variant,
      engineIdentity: current.engineIdentity,
      repetitions: current.repetitions,
    },
    nowIso
  );
  const caseKey = { profileId: profile.id, caseId: request.caseId, rep: request.rep };
  const plannedResults = deciderCasesForRouter(request.baseRouter).length * current.repetitions;
  const stored = await getClientCase(db, caseKey);
  if (stored?.ran) {
    await refreshClientProfileRollup(db, profile, plannedResults, nowIso);
    return { score: stored.score };
  }

  const ran = request.exitCode === 0 && !request.timedOut && request.output.length > 0;
  if (ran && benchCase.check.kind === 'judged') {
    const admission = await deps.admitJudge(request.billing, {
      model: DECIDER_JUDGE_MODEL,
      body: deciderJudgeRequest(DECIDER_JUDGE_MODEL, {
        userPrompt: benchCase.userPrompt,
        output: request.output,
        rubric: benchCase.check.rubric,
        ...(benchCase.check.reference !== undefined
          ? { reference: benchCase.check.reference }
          : {}),
      }),
    });
    if (admission === 'insufficient') {
      throw new ClientEvalError('insufficient_balance', 'Insufficient balance');
    }
    if (admission === 'unavailable') {
      throw new ClientEvalError(
        'internal_error',
        'Judged grading could not be authorized; retry the upload.'
      );
    }
  }
  const grade = ran
    ? await gradeDeciderOutput(benchCase.check, {
        userPrompt: benchCase.userPrompt,
        output: request.output,
        judge: benchCase.check.kind === 'judged' ? await deps.createJudge() : null,
      })
    : { score: 0, costUsd: 0, graderError: null };
  if (grade.score === null) {
    throw new ClientEvalError('internal_error', 'The grader is unavailable; retry the upload.');
  }

  const revision = await saveClientCaseResult(db, {
    profile_id: profile.id,
    case_id: request.caseId,
    rep: request.rep,
    route_key: taxonomyRouteKey(benchCase),
    output: request.output.slice(0, STORED_OUTPUT_MAX_LENGTH),
    cost_usd: request.costUsd,
    duration_ms: Math.round(request.durationMs),
    exit_code: request.exitCode,
    timed_out: request.timedOut,
    score: grade.score,
    grader_cost_usd: grade.costUsd,
    uploaded_at: nowIso,
  });
  if (revision === null) {
    await refreshClientProfileRollup(db, profile, plannedResults, nowIso);
    return { score: (await getClientCase(db, caseKey))?.score ?? grade.score };
  }

  if (grade.costUsd > 0) {
    const billed = await buildGraderUsage(
      request.billing,
      [
        request.billing.userId,
        request.billing.organizationId,
        request.ownerType,
        request.ownerId,
        request.baseRouter,
        entryKey,
        request.variant,
        current.engineIdentity,
        current.repetitions,
        request.caseId,
        request.rep,
      ],
      grade.costUsd,
      nowIso
    )
      .then(usage => deps.writeUsage(usage))
      .then(
        outcome => outcome.kind !== 'unavailable',
        () => false
      );
    if (!billed) {
      await deleteClientCaseUpload(db, { ...caseKey, revision });
      await refreshClientProfileRollup(db, profile, plannedResults, nowIso);
      throw new ClientEvalError(
        'internal_error',
        'Grader usage was not recorded; retry the upload.'
      );
    }
  }

  await refreshClientProfileRollup(db, profile, plannedResults, nowIso);
  return { score: grade.score };
}

async function requireConfig(db: D1Database, router: AutoRouter): Promise<BenchmarkConfig> {
  const config = await getBenchmarkConfig(db, router);
  if (!config) {
    throw new ClientEvalError(
      'custom_router_unavailable',
      `The ${router} base router has no benchmark configuration yet.`
    );
  }
  return config;
}

function errorBody(code: CustomRouterErrorCode, message: string): CustomRouterErrorResponse {
  return { error: { code, message } };
}

export function registerClientEvalRoutes(app: Hono<HonoEnv>): void {
  const route = <S extends z.ZodType, R>(
    path: string,
    schema: S,
    handle: (env: Env, request: z.infer<S>) => Promise<R> | R
  ) =>
    app.post(path, async c => {
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(errorBody('invalid_request', 'Invalid client eval request'), 400);
      }
      try {
        return c.json(await handle(c.env, parsed.data));
      } catch (error) {
        if (error instanceof ClientEvalError) {
          return c.json(
            errorBody(error.code, error.message),
            CUSTOM_ROUTER_ERROR_HTTP_STATUS[error.code]
          );
        }
        console.error(JSON.stringify({ event: 'client_eval_failed', path, ...formatError(error) }));
        return c.json(errorBody('internal_error', 'Client eval request failed'), 500);
      }
    });

  route(CUSTOM_ROUTER_EVAL_PLAN_PATH, InternalClientEvalPlanRequestSchema, async (env, request) =>
    planClientEval(env.BENCH_DB, await requireConfig(env.BENCH_DB, request.baseRouter), request, {
      catalogEnv: env,
    })
  );
  route(CUSTOM_ROUTER_EVAL_CASE_PATH, InternalClientEvalCaseRequestSchema, (_env, request) =>
    clientEvalCase(request)
  );
  route(
    CUSTOM_ROUTER_EVAL_RESULT_PATH,
    InternalClientEvalResultRequestSchema,
    async (env, request) =>
      gradeClientEvalResult(
        env.BENCH_DB,
        await requireConfig(env.BENCH_DB, request.baseRouter),
        request,
        {
          source: { catalogEnv: env },
          admitJudge: (billing, judgeRequest) => admitJudgeInference(env, billing, judgeRequest),
          createJudge: async () => createDeciderJudge(await createSystemOneClient(env)),
          writeUsage: usage => writeGraderUsage(env, usage),
        }
      )
  );
}
