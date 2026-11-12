import * as z from 'zod';
import {
  EnkryptGuardrailReportSchema,
  EnkryptOutputGuardrailReportSchema,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';

/**
 * Reads AI provider metadata objects (see `KiloRoutingDecisionRecordSchema`) for display. Older
 * objects lack fields added later, so a missing or unreadable top-level field reads as null, an
 * unreadable step or BYOK candidate drops only itself, and an Enkrypt report that does not match
 * the current report shape is dropped whole. Unknown keys are stripped, which keeps provider
 * response IDs and client session IDs off the page; this includes the gateway's `vercel` metadata
 * object.
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

const ByokFailoverAttemptSchema = z.object({
  provider_type: optionalString,
  byok_provider_ids: z.array(z.string()).catch([]),
  status: optionalNumber,
  error_code: optionalString,
  duration_ms: optionalNumber,
  outcome: z.string(),
  stop_reason: optionalString,
});

export type RequestLogByokFailoverAttempt = z.infer<typeof ByokFailoverAttemptSchema>;

const AiProviderMetadataRecordSchema = z.object({
  requested_model: z.string().nullable().catch(null),
  api_kind: z.string().nullable().catch(null),
  owner_type: z.string().nullable().catch(null),
  steps: lenientArray(RoutingStepSchema),
  byok_candidates: lenientArray(ByokCandidateSchema),
  result: RoutingResultSchema.nullable().catch(null),
  enkrypt: EnkryptGuardrailReportSchema.nullable().catch(null),
  enkrypt_output: EnkryptOutputGuardrailReportSchema.nullable().catch(null),
  byok_failover_attempts: lenientArray(ByokFailoverAttemptSchema),
});

export type RequestLogRoutingDetails = z.infer<typeof AiProviderMetadataRecordSchema>;

export type RequestLogNotSentReason =
  | 'enkrypt-block'
  | 'enkrypt-unavailable'
  | 'rejected-before-guardrail';

/**
 * Why the request was not sent to the selected provider, or null when it was sent or the record
 * cannot tell. The gateway awaits the input guardrail's verdict just before the upstream request
 * and rejects on a block or unavailable verdict, so a request that never waited for the verdict
 * (`added_latency_ms` is null) was rejected earlier. Records without the guardrail carry no such
 * signal.
 */
export function requestNotSentReason(
  routing: Pick<RequestLogRoutingDetails, 'enkrypt'>
): RequestLogNotSentReason | null {
  const { enkrypt } = routing;
  if (!enkrypt) return null;
  if (enkrypt.added_latency_ms === null) return 'rejected-before-guardrail';
  switch (enkrypt.verdict) {
    case 'block':
      return 'enkrypt-block';
    case 'unavailable':
      return 'enkrypt-unavailable';
    case 'allow':
    case 'skip':
      return null;
  }
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
  return parsed.success ? parsed.data : null;
}
