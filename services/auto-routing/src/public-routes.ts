import {
  AUTO_DECISION_TTL_MS,
  ClientEvalCaseRequestSchema,
  ClientEvalPlanRequestSchema,
  ClientEvalResultUploadSchema,
  CUSTOM_ROUTER_EVAL_CASE_PATH,
  CUSTOM_ROUTER_EVAL_PLAN_PATH,
  CUSTOM_ROUTER_EVAL_RESULT_PATH,
  CustomRouterDecideRequestSchema,
  InternalClientEvalCaseRequestSchema,
  InternalClientEvalPlanRequestSchema,
  InternalClientEvalResultRequestSchema,
  detectRequiredInputModalities,
  estimateRoutingTokens,
  normalizeClassifierInput,
  parseCustomRouterModelId,
  signAutoDecision,
  type CustomRouterDecideResponse,
  type CustomRouterDefinition,
  type MirrorPayload,
} from '@kilocode/auto-routing-contracts';
import type { OrganizationRole } from '@kilocode/db';
import { formatError, getCachedSecret } from '@kilocode/worker-utils';
import { canSpendPaidUsage } from '@kilocode/worker-utils/account-access';
import type { Context, Handler } from 'hono';
import type * as z from 'zod';
import { customRouterBenchmarkContext, forwardClientEval } from './benchmark-origin';
import {
  authenticateCaller,
  CustomRouterError,
  customRouterErrorResponse,
  DEPENDENCY_RETRY_AFTER_SECONDS,
  loadPayerBalanceUsd,
  loadOrganizationBalanceUsd,
  type Caller,
} from './caller-auth';
import {
  customRouterDecision,
  customRouterOwner,
  customRouterTarget,
  customRouting,
  publicCustomRouterDecision,
} from './custom-router-decision';
import { findCustomRouter, findCustomRouterById } from './custom-router-store';
import { runDecision } from './decide';
import type { HonoEnv } from './hono-env';
import { deniedOrganizationModelIds } from './organization-policy';
import { inheritedLegacyPoolMode } from './legacy-pool-overlap';

function publicHandler(handle: (c: Context<HonoEnv>) => Promise<Response>): Handler<HonoEnv> {
  return async c => {
    try {
      return await handle(c);
    } catch (error) {
      if (error instanceof CustomRouterError) return customRouterErrorResponse(error);
      console.error(
        JSON.stringify({
          event: 'auto_routing_public_route_failed',
          path: c.req.path,
          ...formatError(error),
        })
      );
      return customRouterErrorResponse(new CustomRouterError('internal_error', 'Internal error'));
    }
  };
}

async function readJson(c: Context<HonoEnv>): Promise<{ text: string; json: unknown }> {
  const text = await c.req.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    throw new CustomRouterError('invalid_request', 'Invalid JSON body');
  }
}

function parseBody<T extends z.ZodType>(schema: T, json: unknown): z.infer<T> {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new CustomRouterError(
      'invalid_request',
      parsed.error.issues[0]?.message ?? 'Invalid request body'
    );
  }
  return parsed.data;
}

function requirePaidUsageBalance(balanceUsd: number): void {
  if (!canSpendPaidUsage(balanceUsd)) {
    throw new CustomRouterError('insufficient_balance', 'Insufficient balance');
  }
}

export const publicDecideHandler = publicHandler(async c => {
  const caller = await authenticateCaller(c.env, c.req.raw.headers);
  const { text, json } = await readJson(c);
  const request = parseBody(CustomRouterDecideRequestSchema, json);
  const reference = parseCustomRouterModelId(request.model);
  if (!reference) throw new CustomRouterError('invalid_request', 'Not a custom router model ID');
  const owner = customRouterOwner(reference, caller);
  const [stored, balanceUsd] = await Promise.all([
    owner ? findCustomRouter(c.env, owner, reference.slug) : null,
    loadPayerBalanceUsd(caller),
  ]);
  if (!stored) throw new CustomRouterError('router_not_found', 'Custom router not found');
  const router = await inheritedLegacyPoolMode(c.env, stored, caller);
  requirePaidUsageBalance(balanceUsd);
  // The organization model policy filters gateway entries for any router used in that
  // organization's context, including a member's personal router.
  const gatewayModelIds = router.entries.flatMap(entry =>
    entry.kind === 'gateway' ? [entry.model] : []
  );
  const policyDeniedModelIds =
    caller.organizationId === null
      ? []
      : await deniedOrganizationModelIds(c.env, {
          userId: caller.userId,
          organizationId: caller.organizationId,
          modelIds: gatewayModelIds,
        });
  // An unreadable policy admits no gateway entry. The listed client entries can still serve;
  // without one the request is retryable, not a permanently unavailable router.
  if (
    policyDeniedModelIds === null &&
    !router.entries.some(
      entry =>
        entry.kind === 'client' &&
        request.clientEntries.some(
          listed => listed.provider === entry.provider && listed.model === entry.model
        )
    )
  ) {
    throw new CustomRouterError(
      'internal_error',
      'Organization model policy is temporarily unavailable',
      DEPENDENCY_RETRY_AFTER_SECONDS
    );
  }
  const deniedModelIds = policyDeniedModelIds ?? gatewayModelIds;

  const body = { model: request.model, messages: request.messages, tools: request.tools };
  const input = normalizeClassifierInput('chat_completions', body);
  if (!input) throw new CustomRouterError('invalid_request', 'Messages cannot be classified');
  const requiredInputModalities = detectRequiredInputModalities(body);
  const promptTokensEstimate = estimateRoutingTokens(body);
  const payload: MirrorPayload = {
    input,
    router: router.baseRouter,
    ...(deniedModelIds.length > 0 ? { routingPolicy: { deniedModelIds } } : {}),
    ...(requiredInputModalities.length > 0 || promptTokensEstimate > 0
      ? {
          constraints: {
            ...(requiredInputModalities.length > 0 ? { requiredInputModalities } : {}),
            ...(promptTokensEstimate > 0 ? { promptTokensEstimate } : {}),
          },
        }
      : {}),
    userId: caller.userId,
    organizationId: caller.organizationId,
    sessionId: request.sessionId,
    machineId: request.machineId ?? null,
    clientRequestId: request.clientRequestId ?? null,
    mode: request.mode ?? null,
    userAgent: c.req.header('user-agent') ?? null,
    bodyBytes: new TextEncoder().encode(text).byteLength,
    customRouter: reference,
    clientEntries: request.clientEntries,
  };
  const routing = customRouting(router, request.clientEntries, new Set(deniedModelIds));
  const run = await runDecision(
    c,
    payload,
    customRouterTarget(c.env, promise => c.executionCtx.waitUntil(promise), routing)
  );
  const decision = publicCustomRouterDecision(customRouterDecision(routing, run));
  const decisionId = await signAutoDecision(
    {
      userId: caller.userId,
      organizationId: caller.organizationId,
      routerModelId: request.model,
      model: decision.model,
      variant: decision.variant,
      expiresAt: Date.now() + AUTO_DECISION_TTL_MS,
    },
    await getCachedSecret(c.env.AUTO_ROUTING_DECISION_SECRET, 'AUTO_ROUTING_DECISION_SECRET')
  );
  return c.json({ decision, decisionId } satisfies CustomRouterDecideResponse);
});

const ORGANIZATION_ROUTER_EDITOR_ROLES: ReadonlySet<OrganizationRole> = new Set([
  'owner',
  'admin',
  'billing_manager',
]);

// Only router editors run evals: the owning user, or an organization owner, admin, or billing
// manager acting in that organization's context. The router owner pays for grading.
async function loadEditableRouter(
  env: Env,
  caller: Caller,
  routerId: string
): Promise<CustomRouterDefinition> {
  const router = await findCustomRouterById(env, routerId);
  const ownerContext = router?.ownerType === 'org' ? caller.organizationId : caller.userId;
  if (!router || router.ownerId !== ownerContext) {
    throw new CustomRouterError('router_not_found', 'Custom router not found');
  }
  if (
    router.ownerType === 'org' &&
    (caller.organizationRole === null ||
      !ORGANIZATION_ROUTER_EDITOR_ROLES.has(caller.organizationRole))
  ) {
    throw new CustomRouterError('forbidden', 'Only router editors can run evals');
  }
  requirePaidUsageBalance(
    router.ownerType === 'org'
      ? await loadOrganizationBalanceUsd(caller.db, router.ownerId)
      : caller.userBalanceMicrodollars / 1_000_000
  );
  return router;
}

export const evalPlanHandler = publicHandler(async c => {
  const caller = await authenticateCaller(c.env, c.req.raw.headers);
  const request = parseBody(ClientEvalPlanRequestSchema, (await readJson(c)).json);
  const router = await loadEditableRouter(c.env, caller, request.routerId);
  return forwardClientEval(
    c.env,
    CUSTOM_ROUTER_EVAL_PLAN_PATH,
    parseBody(InternalClientEvalPlanRequestSchema, {
      ...request,
      ...customRouterBenchmarkContext(router),
    })
  );
});

export const evalCaseHandler = publicHandler(async c => {
  const caller = await authenticateCaller(c.env, c.req.raw.headers);
  const request = parseBody(ClientEvalCaseRequestSchema, (await readJson(c)).json);
  const router = await loadEditableRouter(c.env, caller, request.routerId);
  return forwardClientEval(
    c.env,
    CUSTOM_ROUTER_EVAL_CASE_PATH,
    parseBody(InternalClientEvalCaseRequestSchema, { ...request, baseRouter: router.baseRouter })
  );
});

export const evalResultHandler = publicHandler(async c => {
  const caller = await authenticateCaller(c.env, c.req.raw.headers);
  const upload = parseBody(ClientEvalResultUploadSchema, (await readJson(c)).json);
  const router = await loadEditableRouter(c.env, caller, upload.routerId);
  return forwardClientEval(
    c.env,
    CUSTOM_ROUTER_EVAL_RESULT_PATH,
    parseBody(InternalClientEvalResultRequestSchema, {
      ...upload,
      ...customRouterBenchmarkContext(router),
      billing: {
        userId: caller.userId,
        organizationId: router.ownerType === 'org' ? router.ownerId : null,
      },
    })
  );
});
