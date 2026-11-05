import * as z from 'zod';
import {
  EnkryptGuardrailReportSchema,
  EnkryptOutputGuardrailReportSchema,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';

/**
 * Reads AI provider metadata objects (see `KiloRoutingDecisionRecordSchema`) for display. Older
 * objects lack fields added later, and the Vercel AI Gateway metadata is not ours, so every part
 * is optional and an unreadable entry drops only itself. Unknown keys are stripped, which keeps
 * provider response IDs and client session IDs off the page.
 */
function lenientArray<T extends z.ZodType>(item: T) {
  return z
    .array(z.unknown())
    .catch([])
    .transform(values =>
      values.flatMap(value => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      })
    );
}

const optionalString = z.string().optional().catch(undefined);
const optionalBoolean = z.boolean().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);
const optionalStrings = z.array(z.string()).optional().catch(undefined);

const RoutingStepSchema = z.object({
  step: z.string(),
  outcome: optionalString,
  reason: optionalString,
  provider_id: optionalString,
  route: optionalString,
  visibility: optionalString,
  catalog_model_id: z.string().nullable().optional().catch(undefined),
  excluded_provider_ids: optionalStrings,
  supported_api_kinds: optionalStrings,
  gateway: optionalString,
  bounded_spending: optionalBoolean,
  organization_disabled_vercel_ai_gateway: optionalBoolean,
  kilo_ignored_providers: optionalStrings,
});

export type RequestLogRoutingStep = z.infer<typeof RoutingStepSchema>;

const ByokCandidateSchema = z.object({
  route: z.string(),
  provider_id: z.string(),
  priority: z.number().nullable().optional().catch(undefined),
  default_rank: optionalNumber,
  route_order: optionalNumber,
  outcome: z.string(),
  reason: optionalString,
});

export type RequestLogByokCandidate = z.infer<typeof ByokCandidateSchema>;

const RoutingResultSchema = z.object({
  kind: z.string(),
  route: z.string().nullable().optional().catch(undefined),
  provider_type: optionalString,
  byok_provider_ids: optionalStrings,
  payer: z.string().nullable().optional().catch(undefined),
  is_free: optionalBoolean,
});

export type RequestLogRoutingResult = z.infer<typeof RoutingResultSchema>;

const InferenceEndpointSchema = z.object({
  slug: optionalString,
  scope: optionalString,
  geoRegion: optionalString,
  providerRegion: optionalString,
});

const VercelProviderAttemptSchema = z.object({
  provider: z.string(),
  credentialType: optionalString,
  success: optionalBoolean,
  statusCode: optionalNumber,
  startTime: optionalNumber,
  endTime: optionalNumber,
  error: optionalString,
  inferenceEndpoint: InferenceEndpointSchema.optional().catch(undefined),
});

const VercelModelAttemptSchema = z.object({
  canonicalSlug: optionalString,
  providerAttempts: lenientArray(VercelProviderAttemptSchema),
});

const VercelGatewayMetadataSchema = z.object({
  routing: z
    .object({
      originalModelId: optionalString,
      resolvedProvider: optionalString,
      finalProvider: optionalString,
      planningReasoning: optionalString,
      fallbacksAvailable: optionalStrings,
      modelAttempts: lenientArray(VercelModelAttemptSchema),
      affinity: z
        .object({ outcome: optionalString, pinnedProvider: optionalString })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
  generationId: optionalString,
});

const AiProviderMetadataRecordSchema = z.object({
  requested_model: optionalString,
  api_kind: optionalString,
  owner_type: optionalString,
  steps: lenientArray(RoutingStepSchema),
  byok_candidates: lenientArray(ByokCandidateSchema),
  result: RoutingResultSchema.nullable().catch(null).default(null),
  vercel: z
    .object({
      metadata: z.object({ gateway: VercelGatewayMetadataSchema.optional().catch(undefined) }),
    })
    .optional()
    .catch(undefined),
  enkrypt: EnkryptGuardrailReportSchema.optional().catch(undefined),
  enkrypt_output: EnkryptOutputGuardrailReportSchema.optional().catch(undefined),
});

export type RequestLogInferenceRegion = {
  slug: string | null;
  scope: string | null;
  geo_region: string | null;
  provider_region: string | null;
};

export type RequestLogVercelAttempt = {
  model: string | null;
  provider: string;
  credential_type: string | null;
  success: boolean | null;
  status_code: number | null;
  duration_ms: number | null;
  error: string | null;
  region: RequestLogInferenceRegion | null;
};

export type RequestLogPlannedProvider = { provider: string; credential: string };

export type RequestLogVercelRouting = {
  original_model: string | null;
  resolved_provider: string | null;
  final_provider: string | null;
  execution_order: RequestLogPlannedProvider[];
  fallbacks_available: string[];
  affinity: { outcome: string | null; pinned_provider: string | null } | null;
  attempts: RequestLogVercelAttempt[];
  generation_id: string | null;
};

export type RequestLogRoutingDetails = {
  requested_model: string | null;
  api_kind: string | null;
  owner_type: string | null;
  steps: RequestLogRoutingStep[];
  byok_candidates: RequestLogByokCandidate[];
  result: RequestLogRoutingResult | null;
  vercel: RequestLogVercelRouting | null;
  enkrypt: z.infer<typeof EnkryptGuardrailReportSchema> | null;
  enkrypt_output: z.infer<typeof EnkryptOutputGuardrailReportSchema> | null;
};

const EXECUTION_ORDER_PREFIX = 'Total execution order:';
const PLANNED_PROVIDER_PATTERN = /^([^\s()]+)\(([^()]+)\)$/;

/**
 * Vercel only reports the full plan as prose, e.g.
 * `... Total execution order: anthropic(BYOK) → bedrock(system)`.
 */
export function parseExecutionOrder(planningReasoning: string): RequestLogPlannedProvider[] {
  const start = planningReasoning.lastIndexOf(EXECUTION_ORDER_PREFIX);
  if (start === -1) return [];
  return planningReasoning
    .slice(start + EXECUTION_ORDER_PREFIX.length)
    .split('→')
    .flatMap(part => {
      const match = PLANNED_PROVIDER_PATTERN.exec(part.trim().replace(/\.$/, ''));
      return match ? [{ provider: match[1], credential: match[2] }] : [];
    });
}

function toVercelRouting(
  gateway: z.infer<typeof VercelGatewayMetadataSchema>
): RequestLogVercelRouting | null {
  const routing = gateway.routing;
  if (!routing) return null;
  return {
    original_model: routing.originalModelId ?? null,
    resolved_provider: routing.resolvedProvider ?? null,
    final_provider: routing.finalProvider ?? null,
    execution_order: routing.planningReasoning
      ? parseExecutionOrder(routing.planningReasoning)
      : [],
    fallbacks_available: routing.fallbacksAvailable ?? [],
    affinity: routing.affinity
      ? {
          outcome: routing.affinity.outcome ?? null,
          pinned_provider: routing.affinity.pinnedProvider ?? null,
        }
      : null,
    attempts: routing.modelAttempts.flatMap(modelAttempt =>
      modelAttempt.providerAttempts.map(attempt => ({
        model: modelAttempt.canonicalSlug ?? null,
        provider: attempt.provider,
        credential_type: attempt.credentialType ?? null,
        success: attempt.success ?? null,
        status_code: attempt.statusCode ?? null,
        duration_ms:
          attempt.startTime !== undefined && attempt.endTime !== undefined
            ? Math.max(0, attempt.endTime - attempt.startTime)
            : null,
        error: attempt.error ?? null,
        region: attempt.inferenceEndpoint
          ? {
              slug: attempt.inferenceEndpoint.slug ?? null,
              scope: attempt.inferenceEndpoint.scope ?? null,
              geo_region: attempt.inferenceEndpoint.geoRegion ?? null,
              provider_region: attempt.inferenceEndpoint.providerRegion ?? null,
            }
          : null,
      }))
    ),
    generation_id: gateway.generationId ?? null,
  };
}

/** Returns null when the object is not JSON or not an object. */
export function parseRoutingDetails(body: string): RequestLogRoutingDetails | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = AiProviderMetadataRecordSchema.safeParse(json);
  if (!parsed.success) return null;
  const record = parsed.data;
  const vercelMetadata = record.vercel?.metadata.gateway;
  return {
    requested_model: record.requested_model ?? null,
    api_kind: record.api_kind ?? null,
    owner_type: record.owner_type ?? null,
    steps: record.steps,
    byok_candidates: record.byok_candidates,
    result: record.result,
    vercel: vercelMetadata ? toVercelRouting(vercelMetadata) : null,
    enkrypt: record.enkrypt ?? null,
    enkrypt_output: record.enkrypt_output ?? null,
  };
}
