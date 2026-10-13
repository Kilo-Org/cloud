import {
  UsageRecordResponseSchema,
  type UsageRecordRequest,
  type UsageRecordResponse,
} from '@kilocode/usage-contracts';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';

export type UsageWriterConfig = {
  url?: string;
  secret?: string;
  protectionBypass?: string;
};

export type UsageWriteOutcome =
  | { kind: 'recorded' | 'duplicate'; result: NonNullable<UsageRecordResponse['result']> }
  | {
      kind: 'unavailable';
      reason:
        | 'missing_config'
        | 'http_error'
        | 'invalid_response'
        | 'not_recorded'
        | 'timeout'
        | 'request_failed';
      status?: number;
    };

// The existing writer allows 150 seconds for its database transaction.
export const USAGE_WRITER_TIMEOUT_MS = 160_000;
export const MAX_WRITER_RESPONSE_BYTES = 4096;

/** One attempt; the future queue consumer owns retries and acknowledgement. */
export async function recordUsage(
  payload: UsageRecordRequest,
  config: UsageWriterConfig
): Promise<UsageWriteOutcome> {
  const unavailable = (
    reason: Extract<UsageWriteOutcome, { kind: 'unavailable' }>['reason'],
    status?: number
  ): UsageWriteOutcome => {
    console.warn('usage writer unavailable', {
      usageId: payload.core.id,
      reason,
      ...(status === undefined ? {} : { status }),
    });
    return { kind: 'unavailable', reason, ...(status === undefined ? {} : { status }) };
  };

  if (!config.url || !config.secret) return unavailable('missing_config');

  const signal = AbortSignal.timeout(USAGE_WRITER_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    response = await fetch(config.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': config.secret,
        ...(config.protectionBypass
          ? { 'x-vercel-protection-bypass': config.protectionBypass }
          : {}),
      },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) return unavailable('http_error', response.status);
    if (!response.body) return unavailable('invalid_response');

    const body = await readBoundedStream(
      response.body as ReadableStream<Uint8Array>,
      MAX_WRITER_RESPONSE_BYTES
    );
    if (!body.ok) return unavailable('invalid_response');
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body.bytes)
    );
    const parsed = UsageRecordResponseSchema.safeParse(value);
    if (!parsed.success) return unavailable('invalid_response');
    if (parsed.data.status === 'not_recorded') return unavailable('not_recorded');
    const result = parsed.data.result;
    if (!result || result.usageId !== payload.core.id) return unavailable('invalid_response');

    console.info('usage writer acknowledged', {
      usageId: payload.core.id,
      outcome: parsed.data.status,
    });
    return { kind: parsed.data.status, result };
  } catch {
    return unavailable(
      signal.aborted ? 'timeout' : response ? 'invalid_response' : 'request_failed'
    );
  } finally {
    // Release unread error bodies without letting cleanup alter the write outcome.
    void response?.body?.cancel().catch(() => {});
  }
}
