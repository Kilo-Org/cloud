import 'server-only';

import {
  CUSTOM_ROUTER_ERROR_HTTP_STATUS,
  CreateCustomRouterRequestSchema,
  CustomRouterClientEntryIdSchema,
  CustomRouterScopeSchema,
  CustomRouterSlugSchema,
  MAX_CUSTOM_ROUTERS_PER_OWNER,
  MAX_CUSTOM_ROUTER_ENTRIES,
  RegisterClientEntryRequestSchema,
  UpdateCustomRouterRequestSchema,
  customRouterEntryKey,
  customRouterModelId,
  isVirtualAutoModelId,
  type AutoRouter,
  type CustomRouterDefinition,
  type CustomRouterEntry,
  type CustomRouterErrorCode,
  type CustomRouterErrorResponse,
  type CustomRouterListEntry,
  type CustomRouterScope,
  type CustomRouterSummary,
  type CustomRouterVariantStatus,
} from '@kilocode/auto-routing-contracts';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { auto_routing_custom_routers, type User } from '@kilocode/db/schema';
import {
  getCustomRouterStatus,
  registerOwnerBenchmarkProfiles,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import {
  customRouterOwnerCondition,
  findCustomRouter,
  findLegacyPoolRouter,
  hasLegacyPoolAccess,
  isCustomRoutersEnabled,
  listCustomRouters,
  toCustomRouterDefinition,
  type CustomRouterOwner,
} from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { ensureOrganizationAccess } from '@kilocode/web-shared/routers/organizations/utils';
import { isDirectByokModelId } from '@kilocode/worker-utils/direct-byok-model';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import * as z from 'zod';
import { buildEligibleCatalog, type EligibleCatalog } from '@/lib/auto-routing-pool-validation';

const BENCHMARK_REGISTER_BATCH_SIZE = 10;
const BENCHMARK_ADMISSION_TIMEOUT_MS = 10_000;
// The entry bounds count UTF-16 code units while this limit counts UTF-8 bytes, so it carries
// headroom above the ASCII size of a maximal router.
export const MAX_CUSTOM_ROUTER_BODY_BYTES = 1024 * 1024;
// 400 bodies from benchmark workers that cannot benchmark the requested base router: a worker
// that predates frontier owner profiles, or one without a saved config for that router.
const UNSUPPORTED_BASE_ROUTER_ERRORS = [
  'only supported by the efficient router',
  'benchmark config not set',
];

export class CustomRouterApiError extends Error {
  readonly code: CustomRouterErrorCode;
  readonly retryAt: string | undefined;

  constructor(code: CustomRouterErrorCode, message: string, retryAt?: string) {
    super(message);
    this.code = code;
    this.retryAt = retryAt;
  }
}

const routerNotFound = () =>
  new CustomRouterApiError('router_not_found', 'Custom router not found');

export function customRouterErrorResponse(error: CustomRouterApiError): NextResponse {
  const body: CustomRouterErrorResponse = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.retryAt ? { retryAt: error.retryAt } : {}),
    },
  };
  return NextResponse.json(body, { status: CUSTOM_ROUTER_ERROR_HTTP_STATUS[error.code] });
}

function invalidRequest(error: z.ZodError): CustomRouterApiError {
  const issue = error.issues[0];
  const path = issue?.path.join('.');
  const message = issue ? (path ? `${path}: ${issue.message}` : issue.message) : 'Invalid request';
  return new CustomRouterApiError('invalid_request', message);
}

export type CustomRouterRequestContext = {
  user: User;
  organization: { id: string; canEdit: boolean } | null;
  customRoutersEnabled: boolean;
};

async function resolveRequestContext(request: NextRequest): Promise<CustomRouterRequestContext> {
  const auth = await getUserFromAuth({ adminOnly: false });
  if (!auth.user) {
    const status = auth.authFailedResponse.status;
    throw new CustomRouterApiError(
      status === 403 ? 'forbidden' : status === 400 ? 'invalid_request' : 'unauthorized',
      'Authentication required'
    );
  }
  const customRoutersEnabled = await isCustomRoutersEnabled(auth.user.id);

  const queryOrganizationId = request.nextUrl.searchParams.get('organizationId');
  const authOrganizationId = auth.organizationId ?? null;
  if (queryOrganizationId && authOrganizationId && queryOrganizationId !== authOrganizationId) {
    throw new CustomRouterApiError(
      'invalid_request',
      'The organizationId query parameter does not match the organization header'
    );
  }
  const organizationId = authOrganizationId ?? queryOrganizationId;
  if (!organizationId) {
    if (!customRoutersEnabled && !(await hasLegacyPoolAccess(auth.user.id))) throw routerNotFound();
    return { user: auth.user, organization: null, customRoutersEnabled };
  }
  if (!z.uuid().safeParse(organizationId).success) {
    throw new CustomRouterApiError('invalid_request', 'Invalid organization ID');
  }

  try {
    const role = await ensureOrganizationAccess({ user: auth.user }, organizationId);
    if (
      !customRoutersEnabled &&
      !(await findLegacyPoolRouter({ type: 'org', id: organizationId })) &&
      !(await hasLegacyPoolAccess(auth.user.id))
    ) {
      throw routerNotFound();
    }
    return {
      user: auth.user,
      customRoutersEnabled,
      organization: {
        id: organizationId,
        canEdit: ORGANIZATION_BILLING_ROLES.some(editorRole => editorRole === role),
      },
    };
  } catch (error) {
    if (error instanceof TRPCError) {
      throw new CustomRouterApiError('forbidden', 'You do not have access to this organization');
    }
    throw error;
  }
}

export async function handleCustomRouterRequest(
  request: NextRequest,
  handler: (context: CustomRouterRequestContext) => Promise<NextResponse>
): Promise<NextResponse> {
  try {
    return await handler(await resolveRequestContext(request));
  } catch (error) {
    if (error instanceof CustomRouterApiError) return customRouterErrorResponse(error);
    throw error;
  }
}

function bodyTooLarge(): CustomRouterApiError {
  return new CustomRouterApiError(
    'invalid_request',
    `Request body must be at most ${MAX_CUSTOM_ROUTER_BODY_BYTES} bytes`
  );
}

async function readBoundedBody(request: NextRequest): Promise<Uint8Array> {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_CUSTOM_ROUTER_BODY_BYTES)
  ) {
    throw bodyTooLarge();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        throw new CustomRouterApiError('invalid_request', 'Could not read the request body');
      }
      if (chunk.done) break;
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_CUSTOM_ROUTER_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The request stays rejected when stream cancellation fails.
        }
        throw bodyTooLarge();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readJsonBody(request: NextRequest): Promise<unknown> {
  const body = await readBoundedBody(request);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new CustomRouterApiError('invalid_request', 'Invalid JSON body');
  }
}

type ScopedOwner = { owner: CustomRouterOwner; canEdit: boolean };

function resolveScopedOwner(
  context: CustomRouterRequestContext,
  scope: CustomRouterScope
): ScopedOwner {
  if (scope === 'user') return { owner: { type: 'user', id: context.user.id }, canEdit: true };
  if (!context.organization) throw routerNotFound();
  return {
    owner: { type: 'org', id: context.organization.id },
    canEdit: context.organization.canEdit,
  };
}

async function resolveEditableOwner(
  context: CustomRouterRequestContext,
  scope: CustomRouterScope
): Promise<CustomRouterOwner> {
  const { owner, canEdit } = resolveScopedOwner(context, scope);
  if (!canEdit) {
    throw new CustomRouterApiError(
      'forbidden',
      'Only organization owners, admins, and billing managers can edit organization routers'
    );
  }
  if (owner.type === 'org') {
    try {
      await requireActiveSubscriptionOrTrial(owner.id);
    } catch (error) {
      if (error instanceof TRPCError) throw new CustomRouterApiError('forbidden', error.message);
      throw error;
    }
  }
  return owner;
}

export function parseRouterParams(params: { scope: string; slug: string }): {
  scope: CustomRouterScope;
  slug: string;
} {
  const scope = CustomRouterScopeSchema.safeParse(params.scope);
  const slug = CustomRouterSlugSchema.safeParse(params.slug);
  if (!scope.success || !slug.success) throw routerNotFound();
  return { scope: scope.data, slug: slug.data };
}

/** ADR 0005: the owner's CLI evaluates every entry the platform key cannot serve. */
export function requiresClientEval(entry: CustomRouterEntry): boolean {
  return entry.kind === 'client' || isDirectByokModelId(entry.model);
}

export function needsClientEval(
  clientEval: boolean,
  variants: readonly CustomRouterVariantStatus[]
): boolean {
  return clientEval && !(variants.length > 0 && variants.every(v => v.status === 'ready'));
}

async function fetchVariantStatuses(
  router: CustomRouterDefinition,
  clientEvalKeys: string[]
): Promise<Map<string, CustomRouterVariantStatus[]> | null> {
  try {
    const result = await getCustomRouterStatus({
      ownerType: router.ownerType,
      ownerId: router.ownerId,
      baseRouter: router.baseRouter,
      entries: router.entries,
      clientEvalEntryKeys: clientEvalKeys,
    });
    if (result.status !== 200 || !('entries' in result.body)) {
      throw new Error(`Custom router status request failed: ${result.status}`);
    }
    return new Map(result.body.entries.map(entry => [entry.key, entry.variants]));
  } catch (error) {
    captureException(error, {
      tags: { source: 'auto_routing_custom_router_status' },
      extra: { routerId: router.id },
    });
    return null;
  }
}

async function toSummary(
  router: CustomRouterDefinition,
  canEdit: boolean
): Promise<CustomRouterSummary> {
  const clientEvalKeys = router.entries.filter(requiresClientEval).map(customRouterEntryKey);
  const clientEval = new Set(clientEvalKeys);
  const statuses = await fetchVariantStatuses(router, clientEvalKeys);
  const entries = router.entries.map((entry): CustomRouterListEntry => {
    const key = customRouterEntryKey(entry);
    const variants = statuses?.get(key) ?? [];
    return {
      key,
      entry,
      needsClientEval: needsClientEval(clientEval.has(key), variants),
      variants,
    };
  });
  return {
    id: router.id,
    scope: router.ownerType,
    slug: router.slug,
    name: router.name,
    modelId: customRouterModelId(router.ownerType, router.slug),
    baseRouter: router.baseRouter,
    mode: router.mode,
    defaultEntryKey: router.defaultEntryKey,
    legacyPool: router.legacyPool ?? false,
    legacyModeInherited: router.legacyModeInherited ?? false,
    canEdit,
    entries,
  };
}

function gatewayEntryRejection(model: string, catalog: EligibleCatalog): string | null {
  if (catalog.byId.has(model) || catalog.byokOnlyIds.has(model)) return null;
  if (isVirtualAutoModelId(model)) return 'Auto routers cannot be pool members';
  if (
    catalog.organizationId &&
    catalog.managedIds.has(model) &&
    !catalog.ownerCatalogIds.has(model)
  ) {
    return 'This model is not allowed for the organization';
  }
  return 'Unknown model. Choose a model from your catalog';
}

async function gatewayEntryRejections(params: {
  userId: string;
  owner: CustomRouterOwner;
  entries: CustomRouterEntry[];
}): Promise<ReadonlyMap<string, string>> {
  const rejections = new Map<string, string>();
  if (!params.entries.some(entry => entry.kind === 'gateway')) return rejections;
  const catalog = await buildEligibleCatalog({
    userId: params.userId,
    organizationId: params.owner.type === 'org' ? params.owner.id : null,
  });
  for (const entry of params.entries) {
    if (entry.kind !== 'gateway') continue;
    const rejection = gatewayEntryRejection(entry.model, catalog);
    if (rejection) rejections.set(customRouterEntryKey(entry), rejection);
  }
  return rejections;
}

function validateNewGatewayEntries(params: {
  entries: CustomRouterEntry[];
  existingKeys: ReadonlySet<string>;
  rejections: ReadonlyMap<string, string>;
}): void {
  params.entries.forEach((entry, index) => {
    const key = customRouterEntryKey(entry);
    const rejection = params.rejections.get(key);
    if (rejection && !params.existingKeys.has(key)) {
      throw new CustomRouterApiError('invalid_request', `entries.${index}: ${rejection}`);
    }
  });
}

type BenchmarkAdmissionPlan = {
  baseRouter: AutoRouter;
  models: string[];
};

function benchmarkAdmissionPlan(
  baseRouter: AutoRouter,
  entries: readonly CustomRouterEntry[]
): BenchmarkAdmissionPlan {
  return {
    baseRouter,
    models: entries.flatMap(entry =>
      entry.kind === 'gateway' && !requiresClientEval(entry) ? [entry.model] : []
    ),
  };
}

function sameAdmissionPlan(a: BenchmarkAdmissionPlan, b: BenchmarkAdmissionPlan): boolean {
  return (
    a.baseRouter === b.baseRouter &&
    a.models.length === b.models.length &&
    a.models.every((model, index) => model === b.models[index])
  );
}

// One in-flight admission per owner: concurrent saves from the same owner queue here instead of on
// an owner-locked database connection, and two saves never register the same owner's models twice.
const ownerAdmissionSlots = new Map<string, Promise<void>>();

async function withOwnerAdmissionSlot<T>(
  owner: CustomRouterOwner,
  run: () => Promise<T>
): Promise<T> {
  const key = `${owner.type}:${owner.id}`;
  const previous = ownerAdmissionSlots.get(key) ?? Promise.resolve();
  const current = previous.then(run);
  const settled = current.then(
    () => undefined,
    () => undefined
  );
  ownerAdmissionSlots.set(key, settled);
  try {
    return await current;
  } finally {
    if (ownerAdmissionSlots.get(key) === settled) ownerAdmissionSlots.delete(key);
  }
}

async function requestPlatformBenchmarks(params: {
  owner: CustomRouterOwner;
  plan: BenchmarkAdmissionPlan;
}): Promise<void> {
  const models = params.plan.models.map(model => ({ model }));
  if (models.length === 0) return;
  const signal = AbortSignal.timeout(BENCHMARK_ADMISSION_TIMEOUT_MS);
  for (let start = 0; start < models.length; start += BENCHMARK_REGISTER_BATCH_SIZE) {
    const registration = {
      router: params.plan.baseRouter,
      ownerType: params.owner.type,
      ownerId: params.owner.id,
      entries: models.slice(start, start + BENCHMARK_REGISTER_BATCH_SIZE),
    };
    const register = () => registerOwnerBenchmarkProfiles(registration, signal);
    // Registration is idempotent for pending, running, and ready profiles, so one retry is safe.
    const result = await register()
      .then(
        first => (!first.ok && first.status >= 500 && !signal.aborted ? register() : first),
        error => {
          if (signal.aborted) throw error;
          return register();
        }
      )
      .catch(error => {
        captureException(error, {
          tags: { source: 'auto_routing_custom_router_admission' },
          extra: { ownerType: params.owner.type, baseRouter: params.plan.baseRouter },
        });
        throw new CustomRouterApiError('internal_error', 'Could not request benchmarks');
      });
    if (result.ok) continue;
    if ('quota' in result) {
      throw new CustomRouterApiError(
        'quota_exceeded',
        `${result.quota.error} New benchmarks can be requested after ${result.quota.retryAt}.`,
        result.quota.retryAt
      );
    }
    if (
      result.status === 400 &&
      UNSUPPORTED_BASE_ROUTER_ERRORS.some(fragment => result.error.error.includes(fragment))
    ) {
      throw new CustomRouterApiError(
        'invalid_request',
        `baseRouter: Benchmarks for the ${params.plan.baseRouter} base router are not available yet. Choose another base router.`
      );
    }
    if (result.status === 400) {
      throw new CustomRouterApiError('invalid_request', result.error.error);
    }
    throw new CustomRouterApiError(
      'internal_error',
      `Could not request benchmarks: ${result.error.error}`
    );
  }
}

/**
 * Registers the owner's platform-servable models before the write transaction opens, so a save
 * never holds a pooled database connection across the outbound call. Registration is idempotent,
 * so a save that later loses a race only repeats profiles that already exist.
 */
async function admitPlatformBenchmarks(params: {
  owner: CustomRouterOwner;
  baseRouter: AutoRouter;
  entries: readonly CustomRouterEntry[];
}): Promise<BenchmarkAdmissionPlan> {
  const plan = benchmarkAdmissionPlan(params.baseRouter, params.entries);
  if (plan.models.length === 0) return plan;
  await withOwnerAdmissionSlot(params.owner, () =>
    requestPlatformBenchmarks({ owner: params.owner, plan })
  );
  return plan;
}

export async function lockOwner(tx: DrizzleTransaction, owner: CustomRouterOwner): Promise<void> {
  const key = `auto-routing-custom-routers:${owner.type}:${owner.id}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

async function findRouter(
  tx: DrizzleTransaction | typeof db,
  owner: CustomRouterOwner,
  slug: string,
  context: CustomRouterRequestContext
): Promise<CustomRouterDefinition> {
  const router = await findCustomRouter(owner, slug, tx);
  if (!router || (!context.customRoutersEnabled && !router.legacyPool)) throw routerNotFound();
  return router;
}

async function saveRouter(
  tx: DrizzleTransaction,
  router: CustomRouterDefinition
): Promise<CustomRouterDefinition> {
  const [row] = await tx
    .update(auto_routing_custom_routers)
    .set({
      name: router.name,
      base_router: router.baseRouter,
      mode: router.mode,
      entries: router.entries,
      default_entry_key: router.defaultEntryKey,
      legacy_mode_inherited: router.legacyModeInherited ?? false,
    })
    .where(eq(auto_routing_custom_routers.id, router.id))
    .returning();
  if (!row) throw routerNotFound();
  return toCustomRouterDefinition(row);
}

async function singleRouterResponse(
  router: CustomRouterDefinition,
  canEdit: boolean,
  status = 200
): Promise<NextResponse> {
  const summary = await toSummary(router, canEdit);
  return NextResponse.json({ router: summary }, { status });
}

export async function listCustomRoutersResponse(
  context: CustomRouterRequestContext
): Promise<NextResponse> {
  const owners: CustomRouterOwner[] = [{ type: 'user', id: context.user.id }];
  if (context.organization) owners.push({ type: 'org', id: context.organization.id });
  const routers = (await listCustomRouters(owners, db)).filter(
    router => context.customRoutersEnabled || router.legacyPool
  );
  const orgCanEdit = context.organization?.canEdit ?? false;
  const summaries = await Promise.all(
    routers.map(router => toSummary(router, router.ownerType === 'user' || orgCanEdit))
  );
  return NextResponse.json({
    routers: summaries,
    canCreate: context.customRoutersEnabled && (!context.organization || orgCanEdit),
  });
}

export async function getCustomRouterResponse(
  context: CustomRouterRequestContext,
  params: { scope: string; slug: string }
): Promise<NextResponse> {
  const { scope, slug } = parseRouterParams(params);
  const { owner, canEdit } = resolveScopedOwner(context, scope);
  return singleRouterResponse(await findRouter(db, owner, slug, context), canEdit);
}

function assertCanCreate(existing: { slug: string }[], slug: string): void {
  if (existing.some(row => row.slug === slug)) {
    throw new CustomRouterApiError(
      'invalid_request',
      `A custom router with slug ${slug} already exists`
    );
  }
  if (existing.length >= MAX_CUSTOM_ROUTERS_PER_OWNER) {
    throw new CustomRouterApiError(
      'invalid_request',
      `An owner can have at most ${MAX_CUSTOM_ROUTERS_PER_OWNER} custom routers`
    );
  }
}

export async function ownerRouterSlugs(
  executor: DrizzleTransaction | typeof db,
  owner: CustomRouterOwner
): Promise<{ slug: string }[]> {
  return executor
    .select({ slug: auto_routing_custom_routers.slug })
    .from(auto_routing_custom_routers)
    .where(customRouterOwnerCondition(owner));
}

/**
 * Catalog I/O and benchmark admission stay outside the owner lock. The transaction serializes the
 * final validation and the write only, so queued saves never hold a pooled connection across an
 * outbound benchmark request. The one exception is in `updateCustomRouterResponse`, which admits the
 * locked definition inside the transaction when a concurrent save changed it after the pre-lock read.
 */
export async function createCustomRouterResponse(
  context: CustomRouterRequestContext,
  request: NextRequest
): Promise<NextResponse> {
  if (!context.customRoutersEnabled) throw routerNotFound();
  const parsed = CreateCustomRouterRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw invalidRequest(parsed.error);
  const input = parsed.data;
  const owner = await resolveEditableOwner(context, input.scope);
  assertCanCreate(await ownerRouterSlugs(db, owner), input.slug);
  const rejections = await gatewayEntryRejections({
    userId: context.user.id,
    owner,
    entries: input.entries,
  });
  validateNewGatewayEntries({ entries: input.entries, existingKeys: new Set(), rejections });
  await admitPlatformBenchmarks({
    owner,
    baseRouter: input.baseRouter,
    entries: input.entries,
  });

  const router = await db.transaction(async tx => {
    await lockOwner(tx, owner);
    assertCanCreate(await ownerRouterSlugs(tx, owner), input.slug);
    validateNewGatewayEntries({ entries: input.entries, existingKeys: new Set(), rejections });
    const [row] = await tx
      .insert(auto_routing_custom_routers)
      .values({
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        created_by_user_id: context.user.id,
        slug: input.slug,
        name: input.name,
        base_router: input.baseRouter,
        mode: input.mode,
        entries: input.entries,
        default_entry_key: input.defaultEntryKey,
      })
      .returning();
    if (!row) throw new Error('Custom router insert returned no row');
    return toCustomRouterDefinition(row);
  });

  return singleRouterResponse(router, true, 201);
}

function applyUpdate(
  current: CustomRouterDefinition,
  input: z.infer<typeof UpdateCustomRouterRequestSchema>
): CustomRouterDefinition {
  const next: CustomRouterDefinition = {
    ...current,
    name: input.name ?? current.name,
    baseRouter: input.baseRouter ?? current.baseRouter,
    mode: input.mode ?? current.mode,
    legacyModeInherited: input.mode === undefined ? current.legacyModeInherited : false,
    entries: input.entries ?? current.entries,
    defaultEntryKey: input.defaultEntryKey ?? current.defaultEntryKey,
  };
  if (!next.entries.some(entry => customRouterEntryKey(entry) === next.defaultEntryKey)) {
    throw new CustomRouterApiError(
      'invalid_request',
      'defaultEntryKey: defaultEntryKey must name a pool entry'
    );
  }
  return next;
}

export async function updateCustomRouterResponse(
  context: CustomRouterRequestContext,
  params: { scope: string; slug: string },
  request: NextRequest
): Promise<NextResponse> {
  const { scope, slug } = parseRouterParams(params);
  const rawInput = await readJsonBody(request);
  const parsed = UpdateCustomRouterRequestSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidRequest(parsed.error);
  const input = parsed.data;
  const owner = await resolveEditableOwner(context, scope);

  const requestedSlug =
    rawInput !== null && typeof rawInput === 'object' && 'slug' in rawInput ? rawInput.slug : slug;
  const rejections = await gatewayEntryRejections({
    userId: context.user.id,
    owner,
    entries: input.entries ?? [],
  });

  const existing = await findRouter(db, owner, slug, context);
  const planned = applyUpdate(existing, input);
  if (planned.legacyPool && requestedSlug !== slug) {
    throw new CustomRouterApiError(
      'invalid_request',
      'The migrated pool slug cannot change during the notice period'
    );
  }
  validateNewGatewayEntries({
    entries: planned.entries,
    existingKeys: new Set(existing.entries.map(customRouterEntryKey)),
    rejections,
  });
  const changesAdmittedPlan = input.entries !== undefined || input.baseRouter !== undefined;
  const admitted = changesAdmittedPlan
    ? await admitPlatformBenchmarks({
        owner,
        baseRouter: planned.baseRouter,
        entries: planned.entries,
      })
    : null;

  const router = await db.transaction(async tx => {
    await lockOwner(tx, owner);
    const current = await findRouter(tx, owner, slug, context);
    if (current.legacyPool && requestedSlug !== slug) {
      throw new CustomRouterApiError(
        'invalid_request',
        'The migrated pool slug cannot change during the notice period'
      );
    }
    const next = applyUpdate(current, input);
    validateNewGatewayEntries({
      entries: next.entries,
      existingKeys: new Set(current.entries.map(customRouterEntryKey)),
      rejections,
    });
    if (
      admitted !== null &&
      !sameAdmissionPlan(admitted, benchmarkAdmissionPlan(next.baseRouter, next.entries))
    ) {
      // A concurrent save changed the base router or pool between the pre-lock read and the lock.
      // Admission is idempotent, so registering the locked plan keeps the persisted router measured.
      await admitPlatformBenchmarks({
        owner,
        baseRouter: next.baseRouter,
        entries: next.entries,
      });
    }
    return saveRouter(tx, next);
  });

  return singleRouterResponse(router, true);
}

export async function deleteCustomRouterResponse(
  context: CustomRouterRequestContext,
  params: { scope: string; slug: string }
): Promise<NextResponse> {
  const { scope, slug } = parseRouterParams(params);
  const owner = await resolveEditableOwner(context, scope);
  await db.transaction(async tx => {
    await lockOwner(tx, owner);
    const current = await findRouter(tx, owner, slug, context);
    if (current.legacyPool) {
      throw new CustomRouterApiError(
        'invalid_request',
        'The migrated pool cannot be deleted during the notice period'
      );
    }
    await tx
      .delete(auto_routing_custom_routers)
      .where(eq(auto_routing_custom_routers.id, current.id));
  });
  return new NextResponse(null, { status: 204 });
}

export async function registerClientEntryResponse(
  context: CustomRouterRequestContext,
  params: { scope: string; slug: string },
  request: NextRequest
): Promise<NextResponse> {
  const { scope, slug } = parseRouterParams(params);
  const parsed = RegisterClientEntryRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw invalidRequest(parsed.error);
  const entry = parsed.data.entry;
  const key = customRouterEntryKey(entry);
  const owner = await resolveEditableOwner(context, scope);

  const router = await db.transaction(async tx => {
    await lockOwner(tx, owner);
    const current = await findRouter(tx, owner, slug, context);
    const index = current.entries.findIndex(existing => customRouterEntryKey(existing) === key);
    if (index === -1 && current.entries.length >= MAX_CUSTOM_ROUTER_ENTRIES) {
      throw new CustomRouterApiError(
        'invalid_request',
        `A custom router can include at most ${MAX_CUSTOM_ROUTER_ENTRIES} models`
      );
    }
    const entries =
      index === -1
        ? [...current.entries, entry]
        : current.entries.map((existing, i) => (i === index ? entry : existing));
    return saveRouter(tx, { ...current, entries });
  });

  return singleRouterResponse(router, true);
}

export async function removeClientEntryResponse(
  context: CustomRouterRequestContext,
  params: { scope: string; slug: string },
  request: NextRequest
): Promise<NextResponse> {
  const { scope, slug } = parseRouterParams(params);
  const parsed = CustomRouterClientEntryIdSchema.safeParse({
    provider: request.nextUrl.searchParams.get('provider') ?? undefined,
    model: request.nextUrl.searchParams.get('model') ?? undefined,
  });
  if (!parsed.success) throw invalidRequest(parsed.error);
  const key = customRouterEntryKey({ kind: 'client', ...parsed.data });
  const owner = await resolveEditableOwner(context, scope);

  const router = await db.transaction(async tx => {
    await lockOwner(tx, owner);
    const current = await findRouter(tx, owner, slug, context);
    if (!current.entries.some(entry => customRouterEntryKey(entry) === key)) return current;
    if (current.defaultEntryKey === key) {
      throw new CustomRouterApiError(
        'invalid_request',
        'Choose another default member before removing this entry'
      );
    }
    return saveRouter(tx, {
      ...current,
      entries: current.entries.filter(entry => customRouterEntryKey(entry) !== key),
    });
  });

  return singleRouterResponse(router, true);
}
