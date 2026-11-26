import 'server-only';

import { createHash } from 'node:crypto';

import {
  CUSTOM_ROUTER_ERROR_HTTP_STATUS,
  CreateCustomRouterRequestSchema,
  CustomRouterClientEntryIdSchema,
  OwnerTypeSchema,
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
  type CustomRouterBenchmarkContext,
  type OwnerType,
  type CustomRouterSummary,
  type CustomRouterVariantStatus,
} from '@kilocode/auto-routing-contracts';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import {
  auto_routing_custom_routers,
  type AutoRoutingCustomRouter,
  type User,
} from '@kilocode/db/schema';
import type { AdminActionAuditAction } from '@kilocode/db/schema-types';
import {
  adminActionContextFromHeaders,
  runElevatedOrganizationWrite,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import {
  getCustomRouterStatus,
  getPlatformMeasurements,
  lookupCustomRouterBlockedModels,
  pausePoolBenchmark,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import {
  customRouterOwnerCondition,
  findCustomRouter,
  listCustomRouters,
  toCustomRouterDefinition,
  type CustomRouterOwner,
} from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  ensureOrganizationAccess,
  organizationRestAccessContext,
  StaffRequestRefusal,
} from '@kilocode/web-shared/routers/organizations/utils';
import { isDirectByokModelId } from '@kilocode/worker-utils/direct-byok-model';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { and, eq, sql } from 'drizzle-orm';
import { NextResponse, type NextRequest } from 'next/server';
import * as z from 'zod';
import { buildEligibleCatalog, type EligibleCatalog } from '@/lib/auto-routing-pool-validation';

// The entry bounds count UTF-16 code units while this limit counts UTF-8 bytes, so it carries
// headroom above the ASCII size of a maximal router.
export const MAX_CUSTOM_ROUTER_BODY_BYTES = 1024 * 1024;

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
  headers: Headers;
};

/** A staff refusal is the shared guard's response, returned verbatim. */
async function resolveRequestContext(
  request: NextRequest
): Promise<CustomRouterRequestContext | NextResponse> {
  const auth = await getUserFromAuth({ adminOnly: false });
  if (!auth.user) {
    const status = auth.authFailedResponse.status;
    throw new CustomRouterApiError(
      status === 403 ? 'forbidden' : status === 400 ? 'invalid_request' : 'unauthorized',
      'Authentication required'
    );
  }

  const queryOrganizationId = request.nextUrl.searchParams.get('organizationId');
  const authOrganizationId = auth.organizationId ?? null;
  if (queryOrganizationId && authOrganizationId && queryOrganizationId !== authOrganizationId) {
    throw new CustomRouterApiError(
      'invalid_request',
      'The organizationId query parameter does not match the organization header'
    );
  }
  const organizationId = authOrganizationId ?? queryOrganizationId;
  if (!organizationId) return { user: auth.user, organization: null, headers: request.headers };
  if (!z.uuid().safeParse(organizationId).success) {
    throw new CustomRouterApiError('invalid_request', 'Invalid organization ID');
  }

  try {
    // Staff without a membership pass only the shared staff guard, with this
    // request's real credential, method and headers.
    const role = await ensureOrganizationAccess(
      organizationRestAccessContext(auth, { headers: request.headers, method: request.method }),
      organizationId
    );
    return {
      user: auth.user,
      organization: {
        id: organizationId,
        canEdit: ORGANIZATION_BILLING_ROLES.some(editorRole => editorRole === role),
      },
      headers: request.headers,
    };
  } catch (error) {
    if (error instanceof TRPCError && error.cause instanceof StaffRequestRefusal) {
      return error.cause.response;
    }
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
    const context = await resolveRequestContext(request);
    if (context instanceof NextResponse) return context;
    return await handler(context);
  } catch (error) {
    if (error instanceof CustomRouterApiError) return customRouterErrorResponse(error);
    throw error;
  }
}

/**
 * Runs a router write for the owner `scope` names, from the editor check on. Its refusals become
 * error responses here, so an organization write a Kilo admin makes through the admin bypass is
 * recorded with the status it answered.
 */
async function runRouterWrite(
  context: CustomRouterRequestContext,
  scope: OwnerType,
  audit: { action: AdminActionAuditAction; message: string; slug: string },
  write: (owner: CustomRouterOwner) => Promise<NextResponse>
): Promise<NextResponse> {
  const { owner } = resolveScopedOwner(context, scope);
  const run = async () => {
    try {
      return await write(await resolveEditableOwner(context, scope));
    } catch (error) {
      if (error instanceof CustomRouterApiError) return customRouterErrorResponse(error);
      throw error;
    }
  };
  if (owner.type !== 'org') return run();
  return runElevatedOrganizationWrite(
    adminActionContextFromHeaders(context.user, context.headers),
    {
      organizationId: owner.id,
      requiredRoles: ORGANIZATION_BILLING_ROLES,
      action: audit.action,
      message: audit.message,
      metadata: { slug: audit.slug },
    },
    run
  );
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

function resolveScopedOwner(context: CustomRouterRequestContext, scope: OwnerType): ScopedOwner {
  if (scope === 'user') return { owner: { type: 'user', id: context.user.id }, canEdit: true };
  if (!context.organization) throw routerNotFound();
  return {
    owner: { type: 'org', id: context.organization.id },
    canEdit: context.organization.canEdit,
  };
}

async function resolveEditableOwner(
  context: CustomRouterRequestContext,
  scope: OwnerType
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
  scope: OwnerType;
  slug: string;
} {
  const scope = OwnerTypeSchema.safeParse(params.scope);
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
  return (
    clientEval &&
    !(
      variants.length > 0 && variants.every(variant => variant.linked || variant.status === 'ready')
    )
  );
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
  for (const entry of params.entries) {
    if (entry.kind === 'gateway' && !requiresClientEval(entry) && entry.measuredAs) {
      throw new CustomRouterApiError(
        'invalid_request',
        'measuredAs is only for entries the platform cannot serve'
      );
    }
  }
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

/**
 * Models this write adds to the pool. A client entry and a `measuredAs` link are measured by the
 * owner's CLI or by the platform measurement they name, so the platform registry says nothing
 * about whether they can be added.
 */
function newlyAddedGatewayModels(
  entries: readonly CustomRouterEntry[],
  existingKeys: ReadonlySet<string>
): Set<string> {
  const models = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'gateway' || entry.measuredAs !== undefined) continue;
    if (existingKeys.has(customRouterEntryKey(entry))) continue;
    models.add(entry.model);
  }
  return models;
}

/**
 * Refuses a new gateway model when any of its supported variant pairs is permanently unavailable
 * at the target base router: this router benchmarks the whole model, so a partially blocked model
 * could never be measured. A model the pool already had keeps its row; the editor shows the
 * reason instead of deleting it.
 *
 * The check fails closed: an unavailable registry lookup refuses the add with a retryable error.
 * Saves that add no gateway model make no lookup, so they keep working through a Worker rollout.
 */
async function validateNewGatewayModels(params: {
  models: Set<string>;
  entries: readonly CustomRouterEntry[];
  baseRouter: AutoRouter;
}): Promise<void> {
  if (params.models.size === 0) return;
  const blocked = await lookupCustomRouterBlockedModels({
    router: params.baseRouter,
    models: [...params.models],
  }).catch(error => {
    captureException(error, { tags: { source: 'auto_routing_custom_router_blocked_models' } });
    throw new CustomRouterApiError(
      'internal_error',
      `Could not verify that the new ${params.baseRouter} pool models can be benchmarked. Try again.`
    );
  });
  const first = blocked.blocked.find(item => params.models.has(item.model));
  if (!first) return;
  const index = params.entries.findIndex(
    entry => entry.kind === 'gateway' && entry.model === first.model
  );
  const variant = first.pair.variant ? ` (variant ${first.pair.variant})` : '';
  const reason = first.failure.reason ?? first.failure.failureClass;
  throw new CustomRouterApiError(
    'invalid_request',
    `entries.${index}: ${first.model} cannot be benchmarked at the ${params.baseRouter} base router: ${first.pair.model}${variant} is permanently unavailable (${reason})`
  );
}

export async function platformMeasurements(baseRouter: AutoRouter) {
  try {
    const result = await getPlatformMeasurements(baseRouter);
    if (result.status !== 200 || !('models' in result.body)) {
      throw new Error(`Platform measurements request failed: ${result.status}`);
    }
    return result.body;
  } catch (error) {
    captureException(error, { tags: { source: 'auto_routing_platform_measurements' } });
    throw new CustomRouterApiError(
      'internal_error',
      'Could not load platform measurements. Try again.'
    );
  }
}

async function validateLinkedEntries(
  entries: CustomRouterEntry[],
  baseRouter: AutoRouter,
  existingEntries: readonly CustomRouterEntry[] = []
): Promise<void> {
  const existingLinks = new Map(
    existingEntries.map(entry => [customRouterEntryKey(entry), entry.measuredAs])
  );
  const needsValidation = (entry: CustomRouterEntry) =>
    entry.measuredAs !== undefined &&
    entry.measuredAs !== existingLinks.get(customRouterEntryKey(entry));
  if (!entries.some(needsValidation)) return;
  const measurements = await platformMeasurements(baseRouter);
  const models = new Set(measurements.models.map(model => model.model));
  entries.forEach((entry, index) => {
    if (needsValidation(entry) && entry.measuredAs && !models.has(entry.measuredAs)) {
      throw new CustomRouterApiError(
        'invalid_request',
        `entries.${index}.measuredAs: ${entry.measuredAs} has no ready platform measurement for the ${baseRouter} base router`
      );
    }
  });
}

export async function lockOwner(tx: DrizzleTransaction, owner: CustomRouterOwner): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerLockKey(owner)}, 0))`);
}

function ownerLockKey(owner: CustomRouterOwner): string {
  return `auto-routing-custom-routers:${owner.type}:${owner.id}`;
}

/**
 * Serializes an alias promotion against every pool entry writer. A promotion takes this key
 * exclusively while it snapshots the affected pools and commits their observed pins; create,
 * update, delete and pin publication take it shared first, so their committed rows either precede
 * the snapshot or land after the alias config already moved. Always before `lockOwner`.
 */
const ALIAS_PROMOTION_LOCK_KEY = 'auto-routing-custom-routers:alias-promotion';

export async function lockAliasPromotionWrite(tx: DrizzleTransaction): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${ALIAS_PROMOTION_LOCK_KEY}, 0))`
  );
}

export async function lockAliasPromotionExclusive(tx: DrizzleTransaction): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${ALIAS_PROMOTION_LOCK_KEY}, 0))`
  );
}

/**
 * Takes every pool owner's lock, in the order every writer takes them, so an ordinary pool save
 * cannot interleave a read of the row with the promotion's rewrite of it.
 *
 * A deployed instance of the previous release takes only `lockOwner`, then re-reads the pool inside
 * its transaction and saves that read. If a promotion rewrote `entries` between that read and the
 * save, the save would erase the new pin. Taking the same keys keeps the promotion ordered against
 * it in both directions without any new protocol on the writer's side, and a writer that lands
 * first still gets pinned, because the promotion re-reads the row under the lock it just took.
 */
export async function lockPoolOwners(
  tx: DrizzleTransaction,
  owners: readonly CustomRouterOwner[]
): Promise<void> {
  const keys = [...new Set(owners.map(ownerLockKey))].sort();
  for (const key of keys) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

/**
 * The immutable pool a benchmark request measures. Paid benchmarks derive it from the saved row,
 * so a request can never benchmark a pool an editor has not persisted, and the Worker needs no
 * PostgreSQL access of its own.
 *
 * It is the full saved pool, including a gateway entry's `servingPin`: the routing table and the
 * per-entry status must keep serving the pinned target. Pin publication therefore changes this
 * context, so a paid start must compare the pool *identity* (`customRouterPoolVersion`), never this
 * object's text.
 */
export function customRouterBenchmarkContext(
  router: CustomRouterDefinition
): CustomRouterBenchmarkContext {
  return {
    ownerType: router.ownerType,
    ownerId: router.ownerId,
    baseRouter: router.baseRouter,
    entries: router.entries,
    clientEvalEntryKeys: router.entries.filter(requiresClientEval).map(customRouterEntryKey),
  };
}

/**
 * The measurement identity of a saved pool: which cases run, never how they are served. A
 * `servingPin` is routing state, so publishing one must neither invalidate a valid quote nor reset
 * a settlement's version, while a concrete model, link, default, or base-router change must.
 * Entry keys are sorted, so entry order is not identity.
 *
 * This is the only value a paid quote needs: the Worker compares `pool_version`, never the context
 * text, because a context has no default entry key and would gain/lose a pin over time.
 */
function customRouterPoolIdentity(router: CustomRouterDefinition): string {
  const entries = router.entries
    .map(entry => ({
      key: customRouterEntryKey(entry),
      entry:
        entry.kind === 'gateway'
          ? { kind: 'gateway' as const, model: entry.model, measuredAs: entry.measuredAs ?? null }
          : {
              kind: 'client' as const,
              provider: entry.provider,
              model: entry.model,
              variants: entry.variants,
              // A client link changes which measurement serves the entry, so it is identity too.
              measuredAs: entry.measuredAs ?? null,
            },
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return JSON.stringify({
    baseRouter: router.baseRouter,
    defaultEntryKey: router.defaultEntryKey,
    entries,
  });
}

/**
 * Names one saved pool state. A quote is bound to it, and a start carries the version of the
 * authorized row it read, so a quote issued for an older pool can never be spent after the pool
 * changes in a way that decides which cases run.
 *
 * The version is the measurement identity only — base router, default entry, and each entry's
 * model/`measuredAs` (client entries also keep their variant list). It deliberately excludes
 * `updated_at`, serving pins, pricing, and capabilities: a no-op client re-registration or a pin
 * publication must not invalidate an outstanding quote, nor reset a settlement's version.
 *
 * A genuine link change is identity in both directions: gaining, moving, or dropping `measuredAs`
 * on a saved entry changes which measurement serves it, so it must invalidate the quote.
 */
export function customRouterPoolVersion(router: CustomRouterDefinition): string {
  return createHash('sha256').update(customRouterPoolIdentity(router)).digest('hex');
}

export type CustomRouterBenchmarkSubject = {
  router: CustomRouterDefinition;
  context: CustomRouterBenchmarkContext;
  poolVersion: string;
};

async function findRouterRow(
  executor: DrizzleTransaction | typeof db,
  owner: CustomRouterOwner,
  slug: string
): Promise<AutoRoutingCustomRouter> {
  const [row] = await executor
    .select()
    .from(auto_routing_custom_routers)
    .where(and(customRouterOwnerCondition(owner), eq(auto_routing_custom_routers.slug, slug)))
    .limit(1);
  if (!row) throw routerNotFound();
  return row;
}

function benchmarkSubjectFromRow(row: AutoRoutingCustomRouter): CustomRouterBenchmarkSubject {
  const router = toCustomRouterDefinition(row);
  return {
    router,
    context: customRouterBenchmarkContext(router),
    poolVersion: customRouterPoolVersion(router),
  };
}

/**
 * Resolves the owner and router from the caller's authorized scope and reads the current saved
 * row from the primary, never a replica: a benchmark quote or start must fence on the pool an
 * editor just wrote.
 */
export async function loadCustomRouterBenchmarkSubject(params: {
  owner: CustomRouterOwner;
  slug: string;
}): Promise<CustomRouterBenchmarkSubject> {
  return benchmarkSubjectFromRow(await findRouterRow(db, params.owner, params.slug));
}

/**
 * Serializes a paid start against pool edits and deletes, which take the same owner lock. The
 * locked row is the only state `run` may act on, so an edit or delete can never commit between
 * the read and the Worker's durable admission.
 *
 * `run` holds a pooled connection for one bounded Worker call. The Worker start must therefore not
 * call back synchronously into this lock (the web pool-pins route takes it): serving-pin
 * publication stays in the Worker's async outbox, never in the start response path.
 */
export async function withLockedCustomRouterBenchmarkSubject<T>(
  params: { owner: CustomRouterOwner; slug: string },
  run: (subject: CustomRouterBenchmarkSubject) => Promise<T>
): Promise<T> {
  return db.transaction(async tx => {
    await lockOwner(tx, params.owner);
    const row = await findRouterRow(tx, params.owner, params.slug);
    return run(benchmarkSubjectFromRow(row));
  });
}

async function findRouter(
  tx: DrizzleTransaction | typeof db,
  owner: CustomRouterOwner,
  slug: string
): Promise<CustomRouterDefinition> {
  const router = await findCustomRouter(owner, slug, tx);
  if (!router) throw routerNotFound();
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
  const routers = await listCustomRouters(owners, db);
  const orgCanEdit = context.organization?.canEdit ?? false;
  const summaries = await Promise.all(
    routers.map(router => toSummary(router, router.ownerType === 'user' || orgCanEdit))
  );
  return NextResponse.json({
    routers: summaries,
    canCreate: !context.organization || orgCanEdit,
  });
}

export async function getCustomRouterResponse(
  context: CustomRouterRequestContext,
  params: { scope: string; slug: string }
): Promise<NextResponse> {
  const { scope, slug } = parseRouterParams(params);
  const { owner, canEdit } = resolveScopedOwner(context, scope);
  return singleRouterResponse(await findRouter(db, owner, slug), canEdit);
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

async function ownerRouterSlugs(
  executor: DrizzleTransaction | typeof db,
  owner: CustomRouterOwner
): Promise<{ slug: string }[]> {
  return executor
    .select({ slug: auto_routing_custom_routers.slug })
    .from(auto_routing_custom_routers)
    .where(customRouterOwnerCondition(owner));
}

/**
 * Catalog I/O stays outside the owner lock. The transaction serializes the final validation and
 * the write only, so queued saves never hold a pooled connection across an outbound catalog or
 * measurement request. `registerClientEntryResponse` looks a client entry's link up before the
 * lock for the same reason, and refuses when the base router changed meanwhile, because a link
 * for the new difficulty cannot be checked without that request.
 */
export async function createCustomRouterResponse(
  context: CustomRouterRequestContext,
  request: NextRequest
): Promise<NextResponse> {
  const parsed = CreateCustomRouterRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw invalidRequest(parsed.error);
  const input = parsed.data;
  return runRouterWrite(
    context,
    input.scope,
    {
      action: 'organization.custom_router.create',
      message: 'Created a custom router',
      slug: input.slug,
    },
    async owner => {
      assertCanCreate(await ownerRouterSlugs(db, owner), input.slug);
      const rejections = await gatewayEntryRejections({
        userId: context.user.id,
        owner,
        entries: input.entries,
      });
      validateNewGatewayEntries({ entries: input.entries, existingKeys: new Set(), rejections });
      await validateNewGatewayModels({
        models: newlyAddedGatewayModels(input.entries, new Set()),
        entries: input.entries,
        baseRouter: input.baseRouter,
      });
      await validateLinkedEntries(input.entries, input.baseRouter);

      const router = await db.transaction(async tx => {
        await lockAliasPromotionWrite(tx);
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
  );
}

function applyUpdate(
  current: CustomRouterDefinition,
  input: z.infer<typeof UpdateCustomRouterRequestSchema>
): CustomRouterDefinition {
  // The write schema strips a client-sent serving pin, and only the benchmark settlement writes
  // one. An edit must keep the stored pin, or a moved alias would stop ranking the target the
  // owner already paid to measure.
  const entries = (input.entries ?? current.entries).map(entry => {
    const stored = current.entries.find(
      candidate => customRouterEntryKey(candidate) === customRouterEntryKey(entry)
    );
    return stored?.kind === 'gateway' &&
      entry.kind === 'gateway' &&
      stored.model === entry.model &&
      stored.servingPin
      ? { ...entry, servingPin: stored.servingPin }
      : entry;
  });
  const next: CustomRouterDefinition = {
    ...current,
    name: input.name ?? current.name,
    baseRouter: input.baseRouter ?? current.baseRouter,
    mode: input.mode ?? current.mode,
    entries,
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
  return runRouterWrite(
    context,
    scope,
    { action: 'organization.custom_router.update', message: 'Updated a custom router', slug },
    async owner => {
      const rejections = await gatewayEntryRejections({
        userId: context.user.id,
        owner,
        entries: input.entries ?? [],
      });

      const existing = await findRouter(db, owner, slug);
      const planned = applyUpdate(existing, input);
      const existingKeys = new Set(existing.entries.map(customRouterEntryKey));
      validateNewGatewayEntries({
        entries: planned.entries,
        existingKeys,
        rejections,
      });
      const plannedAdditions = newlyAddedGatewayModels(planned.entries, existingKeys);
      await validateNewGatewayModels({
        models: plannedAdditions,
        entries: planned.entries,
        baseRouter: planned.baseRouter,
      });
      const changesPoolOrBase = input.entries !== undefined || input.baseRouter !== undefined;
      if (changesPoolOrBase) {
        await validateLinkedEntries(
          planned.entries,
          planned.baseRouter,
          planned.baseRouter === existing.baseRouter ? existing.entries : []
        );
      }

      const router = await db.transaction(async tx => {
        await lockAliasPromotionWrite(tx);
        await lockOwner(tx, owner);
        const current = await findRouter(tx, owner, slug);
        const next = applyUpdate(current, input);
        const currentKeys = new Set(current.entries.map(customRouterEntryKey));
        validateNewGatewayEntries({
          entries: next.entries,
          existingKeys: currentKeys,
          rejections,
        });
        if (changesPoolOrBase) {
          // Links the pre-lock check did not see (a concurrent save or base router change) are
          // checked again; unchanged links cost no request.
          await validateLinkedEntries(
            next.entries,
            next.baseRouter,
            next.baseRouter === planned.baseRouter ? planned.entries : []
          );
          // A risky edit (removal, relink, or base move) stops the live request under this same
          // lock, before the write commits, so no confirmed request keeps measuring a pool that
          // lost a model. Additions alone change nothing in flight and start no work.
          if (requiresPauseBeforeEdit(current, next)) {
            await pausePoolBeforeMutation(owner, current.id);
          }
          // A concurrent save can change which entries this write adds, or move the base router.
          // The blocked-model lookup then runs against the locked definition; a save that adds
          // nothing new repeats no request.
          const lockedAdditions = newlyAddedGatewayModels(next.entries, currentKeys);
          const additionsMoved = [...lockedAdditions].some(model => !plannedAdditions.has(model));
          if (next.baseRouter !== planned.baseRouter || additionsMoved) {
            await validateNewGatewayModels({
              models: lockedAdditions,
              entries: next.entries,
              baseRouter: next.baseRouter,
            });
          }
        }
        return saveRouter(tx, next);
      });

      return singleRouterResponse(router, true);
    }
  );
}

/**
 * An edit keeps or drops money already in flight: removing or relinking a gateway model the pool
 * already had, or moving the base router, would leave a confirmed request measuring a pool that no
 * longer exists. Additions are not risky — they start no work.
 */
function requiresPauseBeforeEdit(
  current: CustomRouterDefinition,
  next: CustomRouterDefinition
): boolean {
  if (next.baseRouter !== current.baseRouter) return true;
  const nextLinks = new Map(
    next.entries.flatMap(entry =>
      entry.kind === 'gateway' ? [[customRouterEntryKey(entry), entry.measuredAs] as const] : []
    )
  );
  return current.entries.some(entry => {
    if (entry.kind !== 'gateway') return false;
    const key = customRouterEntryKey(entry);
    return !nextLinks.has(key) || nextLinks.get(key) !== entry.measuredAs;
  });
}

/**
 * Stops the pool's live request before the caller commits a risky edit or a delete. It runs inside
 * the owner advisory lock that `start` takes, so a start cannot be admitted against the pool after
 * the pause and before the commit. The Worker resolves and pauses the latest request itself: a
 * progress read could stage the next plan, and this fence may only stop work.
 *
 * Anything but a confirmed pause refuses the mutation. The one exception is a Worker that predates
 * the paid path (404): it holds no request state, which is only reachable during the controlled
 * deploy overlap.
 */
async function pausePoolBeforeMutation(owner: CustomRouterOwner, routerId: string): Promise<void> {
  const paused = await pausePoolBenchmark({
    ownerType: owner.type,
    ownerId: owner.id,
    routerId,
  });
  if (paused.ok || paused.status === 404) return;
  throw new CustomRouterApiError(
    'internal_error',
    'Could not stop the running benchmark before changing this pool. Nothing was changed; try again.'
  );
}

export async function deleteCustomRouterResponse(
  context: CustomRouterRequestContext,
  params: { scope: string; slug: string }
): Promise<NextResponse> {
  const { scope, slug } = parseRouterParams(params);
  return runRouterWrite(
    context,
    scope,
    { action: 'organization.custom_router.delete', message: 'Deleted a custom router', slug },
    async owner => {
      await db.transaction(async tx => {
        await lockAliasPromotionWrite(tx);
        await lockOwner(tx, owner);
        const current = await findRouter(tx, owner, slug);
        await pausePoolBeforeMutation(owner, current.id);
        await tx
          .delete(auto_routing_custom_routers)
          .where(eq(auto_routing_custom_routers.id, current.id));
      });
      return new NextResponse(null, { status: 204 });
    }
  );
}

export async function registerClientEntryResponse(
  context: CustomRouterRequestContext,
  params: { scope: string; slug: string },
  request: NextRequest
): Promise<NextResponse> {
  const { scope, slug } = parseRouterParams(params);
  const parsed = RegisterClientEntryRequestSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) throw invalidRequest(parsed.error);
  const incoming = parsed.data.entry;
  const key = customRouterEntryKey(incoming);
  return runRouterWrite(
    context,
    scope,
    {
      action: 'organization.custom_router.client_entry.register',
      message: 'Registered a custom router client entry',
      slug,
    },
    async owner => {
      const planned = await findRouter(db, owner, slug);
      // The link lookup runs before the owner lock, as in create and update, so a queued
      // registration never holds a pooled connection across the outbound request. A registration
      // that carries no new link validates nothing.
      await validateLinkedEntries([incoming], planned.baseRouter, planned.entries);

      const router = await db.transaction(async tx => {
        await lockAliasPromotionWrite(tx);
        await lockOwner(tx, owner);
        const current = await findRouter(tx, owner, slug);
        if (incoming.measuredAs !== undefined && current.baseRouter !== planned.baseRouter) {
          // The link was checked against the base router read before the lock, and a concurrent
          // save changed it. No locked state proves the link for the new difficulty, and the
          // lookup that would is the one that must stay outside this transaction, so the caller
          // registers again.
          throw new CustomRouterApiError(
            'invalid_request',
            'baseRouter: The benchmark difficulty changed while this request was in flight. Try again.'
          );
        }
        const index = current.entries.findIndex(existing => customRouterEntryKey(existing) === key);
        if (index === -1 && current.entries.length >= MAX_CUSTOM_ROUTER_ENTRIES) {
          throw new CustomRouterApiError(
            'invalid_request',
            `A custom router can include at most ${MAX_CUSTOM_ROUTER_ENTRIES} models`
          );
        }
        // Re-registering refreshes capabilities and pricing; a stored link stays unless the CLI
        // sends a new one. The web editor clears links.
        const storedLink = index === -1 ? undefined : current.entries[index]?.measuredAs;
        const entry =
          incoming.measuredAs === undefined && storedLink !== undefined
            ? { ...incoming, measuredAs: storedLink }
            : incoming;
        const entries =
          index === -1
            ? [...current.entries, entry]
            : current.entries.map((existing, i) => (i === index ? entry : existing));
        return saveRouter(tx, { ...current, entries });
      });

      return singleRouterResponse(router, true);
    }
  );
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
  return runRouterWrite(
    context,
    scope,
    {
      action: 'organization.custom_router.client_entry.remove',
      message: 'Removed a custom router client entry',
      slug,
    },
    async owner => {
      const router = await db.transaction(async tx => {
        await lockAliasPromotionWrite(tx);
        await lockOwner(tx, owner);
        const current = await findRouter(tx, owner, slug);
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
  );
}
