import * as z from 'zod';
import { AutoRouterSchema, AutoRoutingModeSchema } from './router';
import { ClassifierSubtaskTypeSchema, ClassifierTaskTypeSchema } from './taxonomy';

// ADR 0005: docs/adr/0005-custom-auto-routers.md

export const CUSTOM_ROUTER_MODEL_PREFIX = 'kilo-auto/custom/';
export const ORG_CUSTOM_ROUTER_MODEL_PREFIX = 'kilo-auto/custom/org/';
export const RESERVED_USER_CUSTOM_ROUTER_SLUG = 'org';
export const MAX_CUSTOM_ROUTERS_PER_OWNER = 10;
export const MAX_CUSTOM_ROUTER_ENTRIES = 20;
export const MAX_CUSTOM_ROUTER_NAME_LENGTH = 100;
export const CUSTOM_ROUTER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Entry fields are client-supplied and stored verbatim, so each one carries an explicit bound.
// Every limit sits far above the real catalogs: gateway and CLI provider/model IDs are well under
// half of them, real context windows stay under 2M tokens, and real prices under $1k per MTok.
export const MAX_CUSTOM_ROUTER_MODEL_ID_LENGTH = 200;
export const MAX_CUSTOM_ROUTER_PROVIDER_ID_LENGTH = 100;
export const MAX_CLIENT_VARIANTS = 20;
export const MAX_CLIENT_VARIANT_LENGTH = 100;
export const MAX_CLIENT_INPUT_MODALITIES = 10;
export const MAX_CLIENT_INPUT_MODALITY_LENGTH = 50;
export const MAX_CLIENT_CONTEXT_LENGTH = 10_000_000;
export const MAX_CLIENT_PRICE_PER_MTOK_USD = 1_000_000;
// `gateway:<model>` or `client:<provider>/<model>` at the bounds above.
export const MAX_CUSTOM_ROUTER_ENTRY_KEY_LENGTH = 320;

export const CustomRouterScopeSchema = z.enum(['user', 'org']);
export type CustomRouterScope = z.infer<typeof CustomRouterScopeSchema>;

export const CustomRouterSlugSchema = z.string().regex(CUSTOM_ROUTER_SLUG_PATTERN);

export const CustomRouterReferenceSchema = z
  .object({
    scope: CustomRouterScopeSchema,
    slug: CustomRouterSlugSchema,
  })
  .superRefine((reference, ctx) => {
    addReservedSlugIssue(reference.scope, reference.slug, ctx);
  });
export type CustomRouterReference = z.infer<typeof CustomRouterReferenceSchema>;

export function isCustomRouterModelId(model: string): boolean {
  return model.startsWith(CUSTOM_ROUTER_MODEL_PREFIX);
}

export function parseCustomRouterModelId(model: string): CustomRouterReference | null {
  if (!isCustomRouterModelId(model)) return null;
  const reference: CustomRouterReference = model.startsWith(ORG_CUSTOM_ROUTER_MODEL_PREFIX)
    ? { scope: 'org', slug: model.slice(ORG_CUSTOM_ROUTER_MODEL_PREFIX.length) }
    : { scope: 'user', slug: model.slice(CUSTOM_ROUTER_MODEL_PREFIX.length) };
  return CustomRouterReferenceSchema.safeParse(reference).success ? reference : null;
}

export function customRouterModelId(scope: CustomRouterScope, slug: string): string {
  return `${scope === 'org' ? ORG_CUSTOM_ROUTER_MODEL_PREFIX : CUSTOM_ROUTER_MODEL_PREFIX}${slug}`;
}

function addReservedSlugIssue(scope: CustomRouterScope, slug: string, ctx: z.RefinementCtx): void {
  if (scope === 'user' && slug === RESERVED_USER_CUSTOM_ROUTER_SLUG) {
    ctx.addIssue({
      code: 'custom',
      path: ['slug'],
      message: `Slug ${RESERVED_USER_CUSTOM_ROUTER_SLUG} is reserved for personal routers`,
    });
  }
}

const ModelIdSchema = z.string().trim().min(1).max(MAX_CUSTOM_ROUTER_MODEL_ID_LENGTH);
export const CLIENT_CANDIDATE_PREFIX = 'client:';
// Provider IDs must not contain '/': the entry key splits at the first '/'.
const ClientProviderIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CUSTOM_ROUTER_PROVIDER_ID_LENGTH)
  .refine(provider => !provider.includes('/'), 'Provider ID must not contain /');

export const GatewayCustomRouterEntrySchema = z.object({
  kind: z.literal('gateway'),
  // The client prefix is reserved so candidate model strings stay injective.
  model: ModelIdSchema.refine(
    model => !model.startsWith(CLIENT_CANDIDATE_PREFIX),
    'Gateway model ID must not start with client:'
  ),
});
export type GatewayCustomRouterEntry = z.infer<typeof GatewayCustomRouterEntrySchema>;

export const ClientModelCapabilitiesSchema = z.object({
  contextLength: z.number().int().positive().max(MAX_CLIENT_CONTEXT_LENGTH).nullable(),
  inputModalities: z
    .array(z.string().trim().min(1).max(MAX_CLIENT_INPUT_MODALITY_LENGTH))
    .max(MAX_CLIENT_INPUT_MODALITIES),
  toolCall: z.boolean(),
  reasoning: z.boolean(),
});
export type ClientModelCapabilities = z.infer<typeof ClientModelCapabilitiesSchema>;

export const ClientModelPricingSchema = z.object({
  inputPerMTokUsd: z.number().finite().nonnegative().max(MAX_CLIENT_PRICE_PER_MTOK_USD),
  outputPerMTokUsd: z.number().finite().nonnegative().max(MAX_CLIENT_PRICE_PER_MTOK_USD),
  cacheReadPerMTokUsd: z
    .number()
    .finite()
    .nonnegative()
    .max(MAX_CLIENT_PRICE_PER_MTOK_USD)
    .optional(),
});
export type ClientModelPricing = z.infer<typeof ClientModelPricingSchema>;

export const ClientCustomRouterEntrySchema = z.object({
  kind: z.literal('client'),
  provider: ClientProviderIdSchema,
  model: ModelIdSchema,
  // Empty means the model has one null variant.
  variants: z
    .array(z.string().trim().min(1).max(MAX_CLIENT_VARIANT_LENGTH))
    .max(MAX_CLIENT_VARIANTS)
    .refine(variants => new Set(variants).size === variants.length, 'Variants must be unique'),
  capabilities: ClientModelCapabilitiesSchema,
  // Null means the model costs $0.
  pricing: ClientModelPricingSchema.nullable(),
});
export type ClientCustomRouterEntry = z.infer<typeof ClientCustomRouterEntrySchema>;

export const CustomRouterEntrySchema = z.discriminatedUnion('kind', [
  GatewayCustomRouterEntrySchema,
  ClientCustomRouterEntrySchema,
]);
export type CustomRouterEntry = z.infer<typeof CustomRouterEntrySchema>;

export const CustomRouterClientEntryIdSchema = z.object({
  provider: ClientProviderIdSchema,
  model: ModelIdSchema,
});
export type CustomRouterClientEntryId = z.infer<typeof CustomRouterClientEntryIdSchema>;

export const CustomRouterEntryRefSchema = z.discriminatedUnion('kind', [
  GatewayCustomRouterEntrySchema,
  CustomRouterClientEntryIdSchema.extend({ kind: z.literal('client') }),
]);
export type CustomRouterEntryRef = z.infer<typeof CustomRouterEntryRefSchema>;

export function customRouterEntryRef(entry: CustomRouterEntryRef): CustomRouterEntryRef {
  return entry.kind === 'gateway'
    ? { kind: 'gateway', model: entry.model }
    : { kind: 'client', provider: entry.provider, model: entry.model };
}

export function customRouterEntryKey(entry: CustomRouterEntryRef): string {
  return entry.kind === 'gateway'
    ? `gateway:${entry.model}`
    : `client:${entry.provider}/${entry.model}`;
}

// Custom routing tables and decisions name a client entry `client:<provider>/<model>`, so policy
// deny lists keyed by gateway model IDs never match a client entry.
export function customRouterCandidateModel(entry: CustomRouterEntryRef): string {
  return entry.kind === 'gateway' ? entry.model : customRouterEntryKey(entry);
}

export function parseCustomRouterCandidateModel(model: string): CustomRouterEntryRef | null {
  if (!model.startsWith(CLIENT_CANDIDATE_PREFIX)) {
    const gateway = GatewayCustomRouterEntrySchema.safeParse({ kind: 'gateway', model });
    return gateway.success ? gateway.data : null;
  }
  const id = model.slice(CLIENT_CANDIDATE_PREFIX.length);
  const separator = id.indexOf('/');
  if (separator === -1) return null;
  const client = CustomRouterEntryRefSchema.safeParse({
    kind: 'client',
    provider: id.slice(0, separator),
    model: id.slice(separator + 1),
  });
  return client.success && customRouterCandidateModel(client.data) === model ? client.data : null;
}

export const CustomRouterEntriesSchema = z
  .array(CustomRouterEntrySchema)
  .min(1)
  .max(MAX_CUSTOM_ROUTER_ENTRIES)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const key = customRouterEntryKey(entry);
      if (seen.has(key)) {
        ctx.addIssue({ code: 'custom', path: [index], message: `Duplicate entry ${key}` });
      }
      seen.add(key);
    });
  });

function addDefaultEntryIssue(
  entries: readonly CustomRouterEntryRef[],
  defaultEntryKey: string,
  ctx: z.RefinementCtx
): void {
  if (!entries.some(entry => customRouterEntryKey(entry) === defaultEntryKey)) {
    ctx.addIssue({
      code: 'custom',
      path: ['defaultEntryKey'],
      message: 'defaultEntryKey must name a pool entry',
    });
  }
}

const CustomRouterNameSchema = z.string().trim().min(1).max(MAX_CUSTOM_ROUTER_NAME_LENGTH);
const EntryKeySchema = z.string().min(1).max(MAX_CUSTOM_ROUTER_ENTRY_KEY_LENGTH);

export const CustomRouterDefinitionSchema = z
  .object({
    id: z.uuid(),
    ownerType: CustomRouterScopeSchema,
    ownerId: z.string().trim().min(1),
    slug: CustomRouterSlugSchema,
    name: CustomRouterNameSchema,
    baseRouter: AutoRouterSchema,
    mode: AutoRoutingModeSchema,
    entries: CustomRouterEntriesSchema,
    defaultEntryKey: EntryKeySchema,
    legacyPool: z.boolean().optional(),
    legacyModeInherited: z.boolean().optional(),
  })
  .superRefine((definition, ctx) => {
    addReservedSlugIssue(definition.ownerType, definition.slug, ctx);
    addDefaultEntryIssue(definition.entries, definition.defaultEntryKey, ctx);
  });
export type CustomRouterDefinition = z.infer<typeof CustomRouterDefinitionSchema>;

// Public auto-routing worker API (CLI path).

export const CUSTOM_ROUTER_DECIDE_PATH = '/v1/decide';
export const CUSTOM_ROUTER_EVAL_PLAN_PATH = '/v1/eval/plan';
export const CUSTOM_ROUTER_EVAL_CASE_PATH = '/v1/eval/case';
export const CUSTOM_ROUTER_EVAL_RESULT_PATH = '/v1/eval/result';
export const AUTO_ROUTING_ORGANIZATION_HEADER = 'X-KiloCode-OrganizationId';

export const CustomRouterErrorCodeSchema = z.enum([
  'unauthorized',
  'forbidden',
  'router_not_found',
  'invalid_request',
  'insufficient_balance',
  'quota_exceeded',
  'custom_router_unavailable',
  'stale_engine_identity',
  'internal_error',
]);
export type CustomRouterErrorCode = z.infer<typeof CustomRouterErrorCodeSchema>;

export const CUSTOM_ROUTER_ERROR_HTTP_STATUS = {
  unauthorized: 401,
  forbidden: 403,
  router_not_found: 404,
  invalid_request: 400,
  insufficient_balance: 402,
  quota_exceeded: 429,
  custom_router_unavailable: 422,
  stale_engine_identity: 409,
  internal_error: 500,
} as const satisfies Record<CustomRouterErrorCode, number>;

export const CustomRouterErrorResponseSchema = z.object({
  error: z.object({
    code: CustomRouterErrorCodeSchema,
    message: z.string(),
    // quota_exceeded only: ISO time when the owner may request new benchmarks.
    retryAt: z.string().optional(),
  }),
});
export type CustomRouterErrorResponse = z.infer<typeof CustomRouterErrorResponseSchema>;

const OptionalIdSchema = z.string().trim().min(1).nullable().optional();

export const CustomRouterDecideRequestSchema = z.object({
  model: z
    .string()
    .refine(model => parseCustomRouterModelId(model) !== null, 'Not a custom router model ID'),
  messages: z.array(z.unknown()),
  tools: z.array(z.unknown()).optional(),
  sessionId: z.string().trim().min(1).nullable(),
  machineId: OptionalIdSchema,
  clientRequestId: OptionalIdSchema,
  // CLI session mode, mirrored from the gateway payload. It never overrides the router's mode.
  mode: OptionalIdSchema,
  clientEntries: z.array(CustomRouterClientEntryIdSchema).max(MAX_CUSTOM_ROUTER_ENTRIES),
});
export type CustomRouterDecideRequest = z.infer<typeof CustomRouterDecideRequestSchema>;

export const CustomRouterDecisionSchema = z
  .object({
    entry: CustomRouterEntryRefSchema,
    model: z.string().min(1),
    variant: z.string().trim().min(1).nullable(),
    stale: z.boolean(),
    // True when no routing decision named a servable entry, so the default or first servable
    // entry was used. taskType and subtaskType still report the classification, if any.
    fallback: z.boolean(),
    sticky: z.boolean(),
    taskType: ClassifierTaskTypeSchema.nullable(),
    subtaskType: ClassifierSubtaskTypeSchema.nullable(),
    tableVersion: z.string().nullable(),
  })
  .superRefine((decision, ctx) => {
    if (decision.model !== customRouterCandidateModel(decision.entry)) {
      ctx.addIssue({ code: 'custom', path: ['model'], message: 'model must match entry' });
    }
  });
export type CustomRouterDecision = z.infer<typeof CustomRouterDecisionSchema>;

export const CustomRouterDecideResponseSchema = z.object({
  decision: CustomRouterDecisionSchema,
  // Signed decision token; the CLI forwards it in AUTO_DECISION_HEADER for gateway picks.
  decisionId: z.string().min(1),
});
export type CustomRouterDecideResponse = z.infer<typeof CustomRouterDecideResponseSchema>;

// Decision token shared by the auto-routing worker (signer) and the gateway (verifier).

export const AUTO_DECISION_HEADER = 'x-kilo-auto-decision';
export const AUTO_DECISION_TTL_MS = 5 * 60 * 1000;
const AUTO_DECISION_CLOCK_SKEW_MS = 30 * 1000;
const AUTO_DECISION_TOKEN_VERSION = 'v1';

export const AutoDecisionPayloadSchema = z.object({
  userId: z.string().min(1),
  organizationId: z.string().min(1).nullable(),
  routerModelId: z.string().min(1),
  model: z.string().min(1),
  variant: z.string().min(1).nullable(),
  // Epoch milliseconds.
  expiresAt: z.number().int().nonnegative(),
});
export type AutoDecisionPayload = z.infer<typeof AutoDecisionPayloadSchema>;

export type AutoDecisionVerification =
  | { ok: true; payload: AutoDecisionPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

const textEncoder = new TextEncoder();
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char =>
      char.charCodeAt(0)
    );
    // Reject non-canonical encodings so one signature has exactly one token text.
    return base64UrlEncode(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function importDecisionKey(secret: string) {
  if (secret.length === 0) throw new Error('Auto decision secret must not be empty');
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signAutoDecision(
  payload: AutoDecisionPayload,
  secret: string
): Promise<string> {
  const body = `${AUTO_DECISION_TOKEN_VERSION}.${base64UrlEncode(
    textEncoder.encode(JSON.stringify(AutoDecisionPayloadSchema.parse(payload)))
  )}`;
  const key = await importDecisionKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyAutoDecision(
  token: string,
  secret: string,
  nowMs: number
): Promise<AutoDecisionVerification> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== AUTO_DECISION_TOKEN_VERSION) {
    return { ok: false, reason: 'malformed' };
  }
  const [version, encodedPayload, encodedSignature] = parts;
  const payloadBytes = base64UrlDecode(encodedPayload);
  const signature = base64UrlDecode(encodedSignature);
  if (payloadBytes === null || signature === null) return { ok: false, reason: 'malformed' };
  const key = await importDecisionKey(secret);
  // WebCrypto HMAC verify compares in constant time.
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    textEncoder.encode(`${version}.${encodedPayload}`)
  );
  if (!valid) return { ok: false, reason: 'bad_signature' };
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const payload = AutoDecisionPayloadSchema.safeParse(json);
  if (!payload.success) return { ok: false, reason: 'malformed' };
  if (payload.data.expiresAt <= nowMs) return { ok: false, reason: 'expired' };
  // The signer never issues a longer lifetime; the margin covers clock skew between the
  // signing worker and the verifying gateway.
  if (payload.data.expiresAt > nowMs + AUTO_DECISION_TTL_MS + AUTO_DECISION_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, payload: payload.data };
}

// Client eval API: public on the auto-routing worker, forwarded to the benchmark worker.
// Golden answers and checks never appear in these schemas (ADR 0005 invariant 3).

export const MAX_CLIENT_EVAL_OUTPUT_LENGTH = 1_000_000;

const RouterIdSchema = z.uuid();
const VariantSchema = z.string().trim().min(1).nullable();
const CaseIdSchema = z.string().trim().min(1);
const RepetitionSchema = z.number().int().nonnegative();

export const ClientEvalPlanRequestSchema = z.object({
  routerId: RouterIdSchema,
});
export type ClientEvalPlanRequest = z.infer<typeof ClientEvalPlanRequestSchema>;

export const ClientEvalPlanItemSchema = z.object({
  entry: CustomRouterEntryRefSchema,
  variant: VariantSchema,
  caseId: CaseIdSchema,
  rep: RepetitionSchema,
});
export type ClientEvalPlanItem = z.infer<typeof ClientEvalPlanItemSchema>;

export const ClientEvalPairSchema = z.object({
  entry: CustomRouterEntryRefSchema,
  variant: VariantSchema,
});
export type ClientEvalPair = z.infer<typeof ClientEvalPairSchema>;

export const ClientEvalPlanResponseSchema = z.object({
  baseRouter: AutoRouterSchema,
  engineIdentity: z.string().min(1),
  repetitions: z.number().int().positive(),
  items: z.array(ClientEvalPlanItemSchema),
  // Pairs whose newest measurement is from an older engine identity. They keep serving, flagged
  // stale, until the plan's items for them are uploaded.
  staleEntries: z.array(ClientEvalPairSchema).default([]),
});
export type ClientEvalPlanResponse = z.infer<typeof ClientEvalPlanResponseSchema>;

export const ClientEvalCaseRequestSchema = z.object({
  routerId: RouterIdSchema,
  caseId: CaseIdSchema,
});
export type ClientEvalCaseRequest = z.infer<typeof ClientEvalCaseRequestSchema>;

export const ClientEvalCaseResponseSchema = z.object({
  caseId: CaseIdSchema,
  baseRouter: AutoRouterSchema,
  // The exact `kilo run` prompt the platform container sends for this case. The CLI must pass it
  // verbatim so client and platform measurements in one custom router share byte-identical prompts.
  prompt: z.string().min(1),
  timeoutMs: z.number().int().positive(),
});
export type ClientEvalCaseResponse = z.infer<typeof ClientEvalCaseResponseSchema>;

export const ClientEvalResultUploadSchema = z.object({
  routerId: RouterIdSchema,
  engineIdentity: z.string().min(1),
  entry: CustomRouterEntryRefSchema,
  variant: VariantSchema,
  caseId: CaseIdSchema,
  rep: RepetitionSchema,
  output: z.string().max(MAX_CLIENT_EVAL_OUTPUT_LENGTH),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative(),
  // Null when the process was killed without an exit code.
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
});
export type ClientEvalResultUpload = z.infer<typeof ClientEvalResultUploadSchema>;

export const ClientEvalResultResponseSchema = z.object({
  score: z.number().min(0).max(1),
});
export type ClientEvalResultResponse = z.infer<typeof ClientEvalResultResponseSchema>;

// Web app REST API, used by the web UI and the CLI.

export const AUTO_ROUTING_CUSTOM_ROUTERS_PATH = '/api/auto-routing/custom-routers';

export function customRouterPath(scope: CustomRouterScope, slug: string): string {
  return `${AUTO_ROUTING_CUSTOM_ROUTERS_PATH}/${scope}/${slug}`;
}

export function customRouterClientEntriesPath(scope: CustomRouterScope, slug: string): string {
  return `${customRouterPath(scope, slug)}/client-entries`;
}

export const CustomRouterEntryStatusSchema = z.enum([
  'missing',
  'pending',
  'running',
  'ready',
  'stale',
  'failed',
]);
export type CustomRouterEntryStatus = z.infer<typeof CustomRouterEntryStatusSchema>;

export const CustomRouterVariantStatusSchema = z.object({
  variant: VariantSchema,
  status: CustomRouterEntryStatusSchema,
  failureReason: z.string().nullable(),
});
export type CustomRouterVariantStatus = z.infer<typeof CustomRouterVariantStatusSchema>;

export const CustomRouterListEntrySchema = z.object({
  key: EntryKeySchema,
  entry: CustomRouterEntrySchema,
  // True when the owner's CLI must run this entry's evals: the platform key cannot serve it.
  needsClientEval: z.boolean(),
  variants: z.array(CustomRouterVariantStatusSchema),
});
export type CustomRouterListEntry = z.infer<typeof CustomRouterListEntrySchema>;

export const CustomRouterSummarySchema = z.object({
  id: RouterIdSchema,
  scope: CustomRouterScopeSchema,
  slug: CustomRouterSlugSchema,
  name: z.string(),
  modelId: z.string().min(1),
  baseRouter: AutoRouterSchema,
  mode: AutoRoutingModeSchema,
  defaultEntryKey: EntryKeySchema,
  canEdit: z.boolean(),
  entries: z.array(CustomRouterListEntrySchema),
  legacyPool: z.boolean().optional(),
  legacyModeInherited: z.boolean().optional(),
});
export type CustomRouterSummary = z.infer<typeof CustomRouterSummarySchema>;

export const CustomRouterListResponseSchema = z.object({
  routers: z.array(CustomRouterSummarySchema),
  canCreate: z.boolean().optional(),
});
export type CustomRouterListResponse = z.infer<typeof CustomRouterListResponseSchema>;

// Create, update, and client-entry registration all return the updated summary.
export const CustomRouterResponseSchema = z.object({
  router: CustomRouterSummarySchema,
});
export type CustomRouterResponse = z.infer<typeof CustomRouterResponseSchema>;

export const CreateCustomRouterRequestSchema = z
  .object({
    scope: CustomRouterScopeSchema,
    slug: CustomRouterSlugSchema,
    name: CustomRouterNameSchema,
    baseRouter: AutoRouterSchema,
    mode: AutoRoutingModeSchema,
    entries: CustomRouterEntriesSchema,
    defaultEntryKey: EntryKeySchema,
  })
  .superRefine((request, ctx) => {
    addReservedSlugIssue(request.scope, request.slug, ctx);
    addDefaultEntryIssue(request.entries, request.defaultEntryKey, ctx);
  });
export type CreateCustomRouterRequest = z.infer<typeof CreateCustomRouterRequestSchema>;

// Scope and slug are immutable: they form the router's model ID.
export const UpdateCustomRouterRequestSchema = z
  .object({
    name: CustomRouterNameSchema.optional(),
    baseRouter: AutoRouterSchema.optional(),
    mode: AutoRoutingModeSchema.optional(),
    entries: CustomRouterEntriesSchema.optional(),
    defaultEntryKey: EntryKeySchema.optional(),
  })
  .superRefine((request, ctx) => {
    if (Object.values(request).every(value => value === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'Update must change at least one field' });
    }
    // Without the default key an entries-only update could leave the stored default outside the
    // new pool, so the two fields move together.
    if (request.entries !== undefined && request.defaultEntryKey === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['defaultEntryKey'],
        message: 'An entries update must also send defaultEntryKey',
      });
    }
    if (request.entries !== undefined && request.defaultEntryKey !== undefined) {
      addDefaultEntryIssue(request.entries, request.defaultEntryKey, ctx);
    }
  });
export type UpdateCustomRouterRequest = z.infer<typeof UpdateCustomRouterRequestSchema>;

export const RegisterClientEntryRequestSchema = z.object({
  entry: ClientCustomRouterEntrySchema,
});
export type RegisterClientEntryRequest = z.infer<typeof RegisterClientEntryRequestSchema>;

// Internal benchmark worker API, behind the internal API secret. The auto-routing worker and the
// web app resolve the router from PostgreSQL and forward its context: the benchmark worker has no
// PostgreSQL access. The client eval routes reuse the public CUSTOM_ROUTER_EVAL_*_PATH paths.

export const CUSTOM_ROUTER_TABLE_PATH = '/admin/custom-router-table';
export const CUSTOM_ROUTER_STATUS_PATH = '/admin/custom-router-status';

const customRouterBenchmarkContextShape = {
  ownerType: CustomRouterScopeSchema,
  ownerId: z.string().trim().min(1),
  baseRouter: AutoRouterSchema,
  entries: CustomRouterEntriesSchema,
  // Keys of the entries the owner's CLI measures: every client entry, and each gateway entry the
  // platform key cannot serve. Their measurements are owner-scoped client profiles.
  clientEvalEntryKeys: z.array(EntryKeySchema),
};

function addClientEvalEntryKeyIssues(
  context: { entries: readonly CustomRouterEntryRef[]; clientEvalEntryKeys: readonly string[] },
  ctx: z.RefinementCtx
): void {
  const entryKeys = new Set(context.entries.map(customRouterEntryKey));
  const listed = new Set<string>();
  context.clientEvalEntryKeys.forEach((key, index) => {
    if (!entryKeys.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['clientEvalEntryKeys', index],
        message: 'clientEvalEntryKeys must name a pool entry',
      });
    } else if (listed.has(key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['clientEvalEntryKeys', index],
        message: `Duplicate client eval entry ${key}`,
      });
    }
    listed.add(key);
  });
  context.entries.forEach((entry, index) => {
    if (entry.kind === 'client' && !listed.has(customRouterEntryKey(entry))) {
      ctx.addIssue({
        code: 'custom',
        path: ['entries', index],
        message: 'Client entries are always measured by the owner CLI',
      });
    }
  });
}

export const CustomRouterBenchmarkContextSchema = z
  .object(customRouterBenchmarkContextShape)
  .superRefine(addClientEvalEntryKeyIssues);
export type CustomRouterBenchmarkContext = z.infer<typeof CustomRouterBenchmarkContextSchema>;

// CUSTOM_ROUTER_TABLE_PATH takes CustomRouterBenchmarkContextSchema and answers with
// CustomRoutingTableResponseSchema: client candidates use customRouterCandidateModel, and rows
// measured under an older engine identity carry `stale: true`.

export const CustomRouterStatusResponseSchema = z.object({
  entries: z.array(
    z.object({
      key: EntryKeySchema,
      variants: z.array(CustomRouterVariantStatusSchema),
    })
  ),
});
export type CustomRouterStatusResponse = z.infer<typeof CustomRouterStatusResponseSchema>;

export const InternalClientEvalPlanRequestSchema = ClientEvalPlanRequestSchema.extend(
  customRouterBenchmarkContextShape
).superRefine(addClientEvalEntryKeyIssues);
export type InternalClientEvalPlanRequest = z.infer<typeof InternalClientEvalPlanRequestSchema>;

export const InternalClientEvalCaseRequestSchema = ClientEvalCaseRequestSchema.extend({
  baseRouter: AutoRouterSchema,
});
export type InternalClientEvalCaseRequest = z.infer<typeof InternalClientEvalCaseRequestSchema>;

// Who pays for judged grading of an upload (ADR 0005 invariant 6), recorded as the usage row's
// user and organization.
export const ClientEvalBillingSchema = z.object({
  userId: z.string().trim().min(1),
  organizationId: z.string().trim().min(1).nullable(),
});
export type ClientEvalBilling = z.infer<typeof ClientEvalBillingSchema>;

export const InternalClientEvalResultRequestSchema = ClientEvalResultUploadSchema.extend({
  ...customRouterBenchmarkContextShape,
  billing: ClientEvalBillingSchema,
}).superRefine((request, ctx) => {
  addClientEvalEntryKeyIssues(request, ctx);
  if (!request.clientEvalEntryKeys.includes(customRouterEntryKey(request.entry))) {
    ctx.addIssue({
      code: 'custom',
      path: ['entry'],
      message: 'entry must be measured by the owner CLI',
    });
  }
});
export type InternalClientEvalResultRequest = z.infer<typeof InternalClientEvalResultRequestSchema>;

export const AUTO_ROUTING_DENIED_MODELS_PATH = '/api/v1/internal/auto-routing/denied-models';

export const AutoRoutingDeniedModelsRequestSchema = z.object({
  userId: z.string().trim().min(1),
  organizationId: z.uuid(),
  modelIds: z.array(ModelIdSchema).max(MAX_CUSTOM_ROUTER_ENTRIES),
});
export type AutoRoutingDeniedModelsRequest = z.infer<typeof AutoRoutingDeniedModelsRequestSchema>;

export const AutoRoutingDeniedModelsResponseSchema = z.object({
  deniedModelIds: z.array(z.string()),
});
export type AutoRoutingDeniedModelsResponse = z.infer<typeof AutoRoutingDeniedModelsResponseSchema>;
