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
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
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

// A decide request carries the whole conversation, inline images included. The limit matches
// the largest request an upstream model provider accepts (Anthropic Messages, 32 MB).
const MAX_DECIDE_REQUEST_BODY_BYTES = 32 * 1000 * 1000;
// An eval plan or case request carries a router ID and a case ID, nothing else.
const MAX_EVAL_PLAN_OR_CASE_REQUEST_BODY_BYTES = 16 * 1000;
// A result upload carries one client output, which the contract caps at 1,000,000 characters.
// JSON escaping costs at most six bytes per character, so a larger body cannot parse into
// that schema.
const MAX_EVAL_RESULT_REQUEST_BODY_BYTES = 8 * 1000 * 1000;

async function readJson(
  c: Context<HonoEnv>,
  maxBytes: number
): Promise<{ byteLength: number; json: unknown }> {
  const body = c.req.raw.body;
  const read = body
    ? await readBoundedStream(body as ReadableStream<Uint8Array>, maxBytes)
    : { ok: true as const, bytes: new Uint8Array() };
  if (!read.ok) throw new CustomRouterError('invalid_request', 'Request body is too large');
  try {
    return {
      byteLength: read.bytes.byteLength,
      json: JSON.parse(new TextDecoder().decode(read.bytes)),
    };
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

// Public routes admit a caller only when the caller's payer balance can fund paid usage.
async function requireCallerPaidUsageBalance(caller: Caller): Promise<void> {
  requirePaidUsageBalance(await loadPayerBalanceUsd(caller));
}

// An eval is paid by the router owner: the caller's own balance for a personal router, or the
// organization balance for an organization router. Either payer admits the request here;
// loadEditableRouter applies the exact owner rule afterwards.
async function requireEvalPayerPaidUsageBalance(caller: Caller): Promise<void> {
  if (canSpendPaidUsage(caller.userBalanceMicrodollars / 1_000_000)) return;
  if (
    caller.organizationId !== null &&
    canSpendPaidUsage(await loadOrganizationBalanceUsd(caller.db, caller.organizationId))
  ) {
    return;
  }
  throw new CustomRouterError('insufficient_balance', 'Insufficient balance');
}

export const publicDecideHandler = publicHandler(async c => {
  const caller = await authenticateCaller(c.env, c.req.raw.headers);
  await requireCallerPaidUsageBalance(caller);
  const { byteLength, json } = await readJson(c, MAX_DECIDE_REQUEST_BODY_BYTES);
  const request = parseBody(CustomRouterDecideRequestSchema, json);
  const reference = parseCustomRouterModelId(request.model);
  if (!reference) throw new CustomRouterError('invalid_request', 'Not a custom router model ID');
  const owner = customRouterOwner(reference, caller);
  const router = owner ? await findCustomRouter(c.env, owner, reference.slug) : null;
  if (!router) throw new CustomRouterError('router_not_found', 'Custom router not found');
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
    bodyBytes: byteLength,
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
  await requireEvalPayerPaidUsageBalance(caller);
  const request = parseBody(
    ClientEvalPlanRequestSchema,
    (await readJson(c, MAX_EVAL_PLAN_OR_CASE_REQUEST_BODY_BYTES)).json
  );
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
  await requireEvalPayerPaidUsageBalance(caller);
  const request = parseBody(
    ClientEvalCaseRequestSchema,
    (await readJson(c, MAX_EVAL_PLAN_OR_CASE_REQUEST_BODY_BYTES)).json
  );
  const router = await loadEditableRouter(c.env, caller, request.routerId);
  return forwardClientEval(
    c.env,
    CUSTOM_ROUTER_EVAL_CASE_PATH,
    parseBody(InternalClientEvalCaseRequestSchema, { ...request, baseRouter: router.baseRouter })
  );
});

export const evalResultHandler = publicHandler(async c => {
  const caller = await authenticateCaller(c.env, c.req.raw.headers);
  await requireEvalPayerPaidUsageBalance(caller);
  const upload = parseBody(
    ClientEvalResultUploadSchema,
    (await readJson(c, MAX_EVAL_RESULT_REQUEST_BODY_BYTES)).json
  );
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
