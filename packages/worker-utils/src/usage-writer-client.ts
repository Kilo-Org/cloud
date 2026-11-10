import {
  EnkryptUsageWriteResponseSchema,
  UsageRecordResponseSchema,
  type EnkryptUsageWrite,
  type EnkryptUsageWriteResponse,
  type UsageRecordRequest,
  type UsageRecordResponse,
} from '@kilocode/usage-contracts';
import { readBoundedStream } from './bounded-stream-reader';
import { z } from 'zod';

const AdmissionRejectionSchema = z.strictObject({
  error: z.literal('Usage writer overloaded'),
  reason: z.enum(['queue_limit', 'pool_waiting', 'pool_busy']),
});
type AdmissionReason = z.infer<typeof AdmissionRejectionSchema>['reason'];

export type UsageWriterConfig = {
  url?: string;
  secret?: string;
  protectionBypass?: string;
  source?: 'queue' | 'queue_vercel';
};

type UnavailableWrite = {
  kind: 'unavailable';
  reason:
    | 'missing_config'
    | 'http_error'
    | 'invalid_response'
    | 'not_recorded'
    | 'timeout'
    | 'request_failed';
  status?: number;
  admissionReason?: AdmissionReason;
};

type AcknowledgedWrite<Result> = { kind: 'recorded' | 'duplicate'; result: Result };

export type UsageWriteOutcome =
  | AcknowledgedWrite<NonNullable<UsageRecordResponse['result']>>
  | UnavailableWrite;

export type EnkryptUsageWriteOutcome =
  | AcknowledgedWrite<EnkryptUsageWriteResponse>
  | UnavailableWrite;

type WriterRequest<Result> = {
  usageId: string;
  usageKind?: 'enkrypt_usage';
  body: unknown;
  acknowledge: (value: unknown) => AcknowledgedWrite<Result> | 'not_recorded' | 'invalid';
};

// The existing writer allows 150 seconds for its database transaction.
export const USAGE_WRITER_TIMEOUT_MS = 160_000;
export const MAX_WRITER_RESPONSE_BYTES = 4096;

/**
 * Only the error name is logged: transport, parse and stream messages can echo the writer URL or
 * the response body. `DOMException` is not always an `Error` instance across realms.
 */
function errorName(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof error.name === 'string'
    ? error.name
    : typeof error;
}

async function sendUsageWrite<Result>(
  request: WriterRequest<Result>,
  config: UsageWriterConfig,
  fetchWriter: typeof fetch
): Promise<AcknowledgedWrite<Result> | UnavailableWrite> {
  const kindField = request.usageKind === undefined ? {} : { usageKind: request.usageKind };
  const unavailable = (
    reason: UnavailableWrite['reason'],
    status?: number,
    admissionReason?: AdmissionReason,
    error?: string
  ): UnavailableWrite => {
    console.warn('usage writer unavailable', {
      usageId: request.usageId,
      ...kindField,
      reason,
      ...(status === undefined ? {} : { status }),
      ...(error === undefined ? {} : { error }),
    });
    return {
      kind: 'unavailable',
      reason,
      ...(status === undefined ? {} : { status }),
      ...(admissionReason === undefined ? {} : { admissionReason }),
    };
  };

  if (!config.url || !config.secret) return unavailable('missing_config');

  const signal = AbortSignal.timeout(USAGE_WRITER_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    response = await fetchWriter(config.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': config.secret,
        ...(config.source ? { 'x-usage-write-source': config.source } : {}),
        ...(config.protectionBypass
          ? { 'x-vercel-protection-bypass': config.protectionBypass }
          : {}),
      },
      body: JSON.stringify(request.body),
      signal,
    });
    if (response.status === 429) {
      let admissionReason: AdmissionReason | undefined;
      let bodyError: string | undefined;
      try {
        if (response.body) {
          const body = await readBoundedStream(response.body, MAX_WRITER_RESPONSE_BYTES);
          if (body.ok) {
            const value: unknown = JSON.parse(
              new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body.bytes)
            );
            const parsed = AdmissionRejectionSchema.safeParse(value);
            if (parsed.success) admissionReason = parsed.data.reason;
          }
        }
      } catch (error) {
        // A partial, slow or malformed rejection remains generic HTTP 429 overload.
        bodyError = errorName(error);
      }
      return unavailable('http_error', 429, admissionReason, bodyError);
    }
    if (!response.ok) return unavailable('http_error', response.status);
    if (!response.body) return unavailable('invalid_response');

    const body = await readBoundedStream(response.body, MAX_WRITER_RESPONSE_BYTES);
    if (!body.ok) return unavailable('invalid_response');
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body.bytes)
    );
    const acknowledgement = request.acknowledge(value);
    if (acknowledgement === 'not_recorded') return unavailable('not_recorded');
    if (acknowledgement === 'invalid') return unavailable('invalid_response');

    console.info('usage writer acknowledged', {
      usageId: request.usageId,
      ...kindField,
      outcome: acknowledgement.kind,
    });
    return acknowledgement;
  } catch (error) {
    return unavailable(
      signal.aborted ? 'timeout' : response ? 'invalid_response' : 'request_failed',
      undefined,
      undefined,
      errorName(error)
    );
  } finally {
    // Release unread error bodies without letting cleanup alter the write outcome. A read body is
    // already closed, cancelled or errored, and cancelling an errored stream rejects again.
    if (response && !response.bodyUsed)
      void response.body?.cancel().catch((error: unknown) => {
        console.warn('usage writer response release failed', {
          usageId: request.usageId,
          ...kindField,
          error: errorName(error),
        });
      });
  }
}

export function recordUsage(
  payload: UsageRecordRequest,
  config: UsageWriterConfig,
  fetchWriter: typeof fetch = fetch
): Promise<UsageWriteOutcome> {
  return sendUsageWrite(
    {
      usageId: payload.core.id,
      body: payload,
      acknowledge(value) {
        const parsed = UsageRecordResponseSchema.safeParse(value);
        if (!parsed.success) return 'invalid';
        if (parsed.data.status === 'not_recorded') return 'not_recorded';
        const result = parsed.data.result;
        if (!result || result.usageId !== payload.core.id) return 'invalid';
        return { kind: parsed.data.status, result };
      },
    },
    config,
    fetchWriter
  );
}

/**
 * The echo is optional in the contract for writers deployed before it, but a queued delivery is
 * acknowledged only by an echo of this record's id.
 */
export function recordEnkryptUsage(
  record: EnkryptUsageWrite,
  config: UsageWriterConfig,
  fetchWriter: typeof fetch = fetch
): Promise<EnkryptUsageWriteOutcome> {
  return sendUsageWrite(
    {
      usageId: record.id,
      usageKind: 'enkrypt_usage',
      body: record,
      acknowledge(value) {
        const parsed = EnkryptUsageWriteResponseSchema.safeParse(value);
        if (!parsed.success || parsed.data.usageId !== record.id) return 'invalid';
        return { kind: parsed.data.status, result: parsed.data };
      },
    },
    config,
    fetchWriter
  );
}
