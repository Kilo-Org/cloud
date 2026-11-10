import * as z from 'zod';
import {
  EnkryptGuardrailReportSchema,
  EnkryptOutputGuardrailReportSchema,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';

/**
 * Reads AI provider metadata objects (see `KiloRoutingDecisionRecordSchema`) for display. Older
 * objects lack fields added later, so every part is optional and an unreadable entry drops only
 * itself. Unknown keys are stripped, which keeps provider response IDs and client session IDs off
 * the page; this includes the gateway's `vercel` metadata object.
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

const AiProviderMetadataRecordSchema = z.object({
  requested_model: optionalString,
  api_kind: optionalString,
  owner_type: optionalString,
  steps: lenientArray(RoutingStepSchema),
  byok_candidates: lenientArray(ByokCandidateSchema),
  result: RoutingResultSchema.nullable().catch(null).default(null),
  enkrypt: EnkryptGuardrailReportSchema.optional().catch(undefined),
  enkrypt_output: EnkryptOutputGuardrailReportSchema.optional().catch(undefined),
});

export type RequestLogRoutingDetails = {
  requested_model: string | null;
  api_kind: string | null;
  owner_type: string | null;
  steps: RequestLogRoutingStep[];
  byok_candidates: RequestLogByokCandidate[];
  result: RequestLogRoutingResult | null;
  enkrypt: z.infer<typeof EnkryptGuardrailReportSchema> | null;
  enkrypt_output: z.infer<typeof EnkryptOutputGuardrailReportSchema> | null;
};

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
  return {
    requested_model: record.requested_model ?? null,
    api_kind: record.api_kind ?? null,
    owner_type: record.owner_type ?? null,
    steps: record.steps,
    byok_candidates: record.byok_candidates,
    result: record.result,
    enkrypt: record.enkrypt ?? null,
    enkrypt_output: record.enkrypt_output ?? null,
  };
}
