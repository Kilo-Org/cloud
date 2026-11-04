import 'server-only';

import { after, NextResponse } from 'next/server';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import {
  ENKRYPT_GUARDRAIL_TIMEOUT_MS,
  ENKRYPT_MAX_SCAN_CHARACTERS,
  responseBlockMessage,
  scanRequest,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
  type EnkryptGuardrailVerdict,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import { usageRecordsWithAddedLatency } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/input-guardrail';
import {
  extractResponseText,
  type ResponseBodyFormat,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/response-text';
import { enkryptOutputGuardrailRejectionResponse } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/responses';
import {
  resolveEnkryptOutputGuardrail,
  splitEnkryptInputGuardrail,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import {
  enkryptCreditsToMicrodollars,
  recordEnkryptUsage,
  type EnkryptGuardrailCall,
  type EnkryptUsageRecord,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getOutputHeaders } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ENKRYPT_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/** The request a response scan belongs to. The scanned text is the response. */
export type EnkryptOutputScan = Omit<EnkryptGuardrailScan, 'text'>;

/** The response scan of an organization member's request, or null without an output guardrail. */
export function resolveEnkryptOutputScan(
  request: Omit<EnkryptOutputScan, 'config'>,
  settings: OrganizationSettings | undefined
): EnkryptOutputScan | null {
  const config = resolveEnkryptOutputGuardrail(request.organizationId, settings);
  return config && { ...request, config };
}

/**
 * A held-back response is kept in memory until it is scanned. Model output is far smaller than
 * this; stream framing repeats ids and metadata in every event, so the cap is well above the scan
 * limit in characters.
 */
export const MAX_HELD_OUTPUT_BYTES = 64 * 1024 * 1024;

const SHORTER_RESPONSE_ADVICE =
  'Ask for a shorter response, for example by lowering the maximum output tokens, then retry.';

const HELD_OUTPUT_TOO_LARGE_MESSAGE = `Your organization's Enkrypt AI guardrail cannot hold back more than ${MAX_HELD_OUTPUT_BYTES / 1024 / 1024} MB of model response at once, so this response was withheld. ${SHORTER_RESPONSE_ADVICE}`;

const OUTPUT_TOO_LARGE_MESSAGE = `Your organization's Enkrypt AI guardrail cannot scan more than ${ENKRYPT_MAX_SCAN_CHARACTERS.toLocaleString('en-US')} characters of model output at once, so this response was withheld. ${SHORTER_RESPONSE_ADVICE}`;

const outputTooLarge: EnkryptGuardrailScanResult = {
  verdict: { action: 'block', message: OUTPUT_TOO_LARGE_MESSAGE },
  usageRecords: [],
};

/** Responses that `scanRequest` would reject as too large never reach it, so it is not billed. */
function isTooLargeToScan(text: string): boolean {
  return text.length > ENKRYPT_MAX_SCAN_CHARACTERS;
}

function asResponseVerdict(verdict: EnkryptGuardrailVerdict): EnkryptGuardrailVerdict {
  return verdict.action === 'block'
    ? { action: 'block', message: responseBlockMessage(verdict.message) }
    : verdict;
}

/** The comment the response rewrite already sends for upstream keep-alives. */
const KEEP_ALIVE_COMMENT = ': KILO PROCESSING\n\n';

/**
 * Clients and proxies time out a response that sends nothing for minutes, while generation alone
 * can take that long.
 */
export const OUTPUT_KEEP_ALIVE_INTERVAL_MS = 15_000;

type BufferedBody = {
  chunks: Uint8Array[];
  readError: { cause: unknown } | null;
  overLimit: boolean;
};

type OutputDecision =
  | { action: 'release'; response: Response }
  | { action: 'reject'; response: NextResponse; verdict: EnkryptGuardrailVerdict };

const notScanned: EnkryptGuardrailScanResult = { verdict: { action: 'skip' }, usageRecords: [] };

async function readBody(body: ReadableStream<Uint8Array>): Promise<BufferedBody> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { chunks, readError: null, overLimit: false };
      bytes += value.byteLength;
      if (bytes > MAX_HELD_OUTPUT_BYTES) {
        await reader.cancel().catch(() => {});
        return { chunks, readError: null, overLimit: true };
      }
      chunks.push(value);
    }
  } catch (cause) {
    return { chunks, readError: { cause }, overLimit: false };
  }
}

function bodyText({ chunks }: BufferedBody): string {
  const decoder = new TextDecoder();
  return chunks.map(chunk => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

function bufferedBytes({ chunks }: BufferedBody): number {
  return chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
}

/**
 * The upstream response with its scanned body. A body that failed while it was read fails again
 * after the same chunks, so the response rewrite reports the upstream failure as it would without
 * the guardrail.
 */
function replayedResponse(response: Response, body: BufferedBody): Response {
  const chunks = body.chunks.values();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.next();
      if (!next.done) controller.enqueue(next.value);
      else if (body.readError) controller.error(body.readError.cause);
      else controller.close();
    },
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Matches how the response rewrite reads the body. */
function bodyFormat(response: Response): ResponseBodyFormat {
  return response.headers.get('content-type')?.includes('application/json') ? 'json' : 'sse';
}

function outputUsageRecords(
  blockingCalls: EnkryptGuardrailCall[],
  logOnlyCalls: EnkryptGuardrailCall[],
  addedLatencyMs: number
): EnkryptUsageRecord[] {
  return usageRecordsWithAddedLatency(blockingCalls, logOnlyCalls, addedLatencyMs).map(
    usageRecord => ({ ...usageRecord, guardrail: 'output' })
  );
}

/** Never rejects: a failed write is logged and the record dropped, like the input guardrail's. */
async function recordEnkryptUsageRecords(usageRecords: EnkryptUsageRecord[]): Promise<void> {
  await Promise.all(
    usageRecords.map(usageRecord =>
      recordEnkryptUsage(usageRecord).catch((error: unknown) => {
        console.error('[enkrypt-guardrail] usage record write failed; record dropped', {
          guardrail: 'output',
          organization_id: usageRecord.organizationId,
          kilo_user_id: usageRecord.kiloUserId,
          session_id: usageRecord.sessionId,
          api_kind: usageRecord.apiKind,
          decision: usageRecord.decision,
          credits_cost: usageRecord.creditsCost,
          charged_microdollars: enkryptCreditsToMicrodollars(usageRecord.creditsCost),
          added_latency_ms: usageRecord.addedLatencyMs,
          error: error instanceof Error ? error.message : String(error),
        });
      })
    )
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TIMED_OUT = Symbol('timed out');

async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(resolve, ms, TIMED_OUT);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Commits a streamed request to a stream before its response is known, sending keep-alive
 * comments until the response is released or rejected, then that response's events. Headers are
 * sent first, so they are the upstream ones the response rewrite keeps; a rejection's retry headers
 * do not apply to an error event inside a stream.
 */
function streamOnceDecided(upstream: Response, response: Promise<Response>): NextResponse {
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(KEEP_ALIVE_COMMENT));
    },
    async pull(controller) {
      if (!reader) {
        const decided = await within(response, OUTPUT_KEEP_ALIVE_INTERVAL_MS);
        if (decided === TIMED_OUT) {
          controller.enqueue(encoder.encode(KEEP_ALIVE_COMMENT));
          return;
        }
        if (!decided.body) {
          controller.close();
          return;
        }
        reader = decided.body.getReader();
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
  const headers = getOutputHeaders(upstream);
  headers.set('content-type', 'text/event-stream');
  return new NextResponse(stream, { status: 200, headers });
}

type GuardEnkryptOutputParams = {
  /** The upstream response, with its body not yet read. */
  response: Response;
  /** Null when the organization has no output guardrail. */
  scan: EnkryptOutputScan | null;
  kind: GatewayChatApiKind;
  /** Whether the client asked for a stream, which decides the shape of a rejection. */
  stream: boolean;
  signal: AbortSignal;
  /** Turns the upstream response, or its scanned replay, into the client's response. */
  release: (response: Response) => Promise<NextResponse>;
  /** Called before a rejection replaces the response. */
  onReject: (rejection: NextResponse, verdict: EnkryptGuardrailVerdict) => Promise<void>;
};

/**
 * Applies the organization's output guardrail to a successful upstream response and returns the
 * client's response.
 *
 * With a blocking detector, the whole upstream response is read before any of it reaches the
 * client, so a streamed response arrives at once after generation and the scan; the stream itself
 * starts at once with keep-alive comments. The response is released only when the blocking scan
 * allows it. A block, or any failure of the scan, replaces it with a rejection, so unscanned output
 * never reaches the client.
 *
 * Log-only detectors never delay the response: they scan a copy of the body after it ends, and
 * only log. Usage records are written in `after()`.
 *
 * The caller accounts for upstream usage from its own copy of the response, so a rejected
 * response is still billed.
 */
export async function guardEnkryptOutput({
  response,
  scan,
  kind,
  stream,
  signal,
  release,
  onReject,
}: GuardEnkryptOutputParams): Promise<NextResponse> {
  // Upstream error bodies are not model output.
  if (!scan || !response.ok || !response.body) return release(response);
  const { body } = response;
  const { blocking, logOnly } = splitEnkryptInputGuardrail(scan.config);
  const format = bodyFormat(response);
  const deps = { apiKey: ENKRYPT_API_KEY, fetch, timeoutMs: ENKRYPT_GUARDRAIL_TIMEOUT_MS, signal };
  const logFields = {
    guardrail: 'output',
    organization_id: scan.organizationId,
    session_id: scan.sessionId,
    client_request_id: scan.clientRequestId,
    api_kind: scan.apiKind,
  };
  const scanOutput = (config: EnkryptOutputScan['config'], text: string) =>
    scanRequest({ ...scan, config, text }, deps);
  const finish = async (decision: OutputDecision): Promise<NextResponse> => {
    if (decision.action === 'release') return release(decision.response);
    await onReject(decision.response, decision.verdict);
    return decision.response;
  };
  const reject = (verdict: EnkryptGuardrailVerdict): OutputDecision => {
    warnExceptInTest('[enkrypt-guardrail] output withheld', {
      ...logFields,
      verdict: verdict.action,
      reason: verdict.action === 'unavailable' ? verdict.reason : undefined,
    });
    const rejection = enkryptOutputGuardrailRejectionResponse(kind, verdict, stream);
    return rejection
      ? { action: 'reject', response: rejection, verdict }
      : { action: 'release', response };
  };

  if (!blocking) {
    const copy = logOnly && response.clone().body;
    if (logOnly && copy) {
      after(
        (async () => {
          try {
            const copied = await readBody(copy);
            if (copied.overLimit) {
              warnExceptInTest('[enkrypt-guardrail] output too large to scan; not logged', {
                ...logFields,
                max_bytes: MAX_HELD_OUTPUT_BYTES,
              });
              return;
            }
            const text = extractResponseText(kind, format, bodyText(copied));
            if (isTooLargeToScan(text)) {
              warnExceptInTest('[enkrypt-guardrail] output too large to scan; not logged', {
                ...logFields,
                scanned_characters: text.length,
              });
              return;
            }
            const result = await scanOutput(logOnly, text);
            await recordEnkryptUsageRecords(outputUsageRecords([], result.usageRecords, 0));
          } catch (error) {
            console.error('[enkrypt-guardrail] log-only output scan failed unexpectedly', {
              ...logFields,
              error: errorMessage(error),
            });
          }
        })()
      );
    }
    return release(response);
  }

  if (scan.config.status === 'invalid') {
    void body.cancel().catch(() => {});
    warnExceptInTest('[enkrypt-guardrail] decision', {
      ...logFields,
      decision: 'error_fail_closed',
      error: 'invalid_config',
    });
    return finish(reject({ action: 'unavailable', reason: 'failed' }));
  }

  const scanned = (async () => {
    const bufferStartedAt = performance.now();
    const buffered = await readBody(body);
    console.debug('[enkrypt-guardrail] output held back', {
      ...logFields,
      held_ms: Math.round(performance.now() - bufferStartedAt),
      held_bytes: bufferedBytes(buffered),
      read_failed: buffered.readError !== null,
      over_limit: buffered.overLimit,
    });
    if (buffered.overLimit) {
      return {
        decision: reject({ action: 'block', message: HELD_OUTPUT_TOO_LARGE_MESSAGE }),
        usageRecords: Promise.resolve([]),
      };
    }

    const text = Promise.resolve().then(() =>
      extractResponseText(kind, format, bodyText(buffered))
    );
    const blockingResult = text
      .then(scannedText =>
        isTooLargeToScan(scannedText) ? outputTooLarge : scanOutput(blocking, scannedText)
      )
      .catch((error: unknown): EnkryptGuardrailScanResult => {
        console.error('[enkrypt-guardrail] output scan failed unexpectedly; response withheld', {
          ...logFields,
          error: errorMessage(error),
        });
        return { verdict: { action: 'unavailable', reason: 'failed' }, usageRecords: [] };
      });
    const logOnlyResult = text
      .then(scannedText =>
        logOnly && !isTooLargeToScan(scannedText) ? scanOutput(logOnly, scannedText) : notScanned
      )
      .catch((error: unknown): EnkryptGuardrailScanResult => {
        console.error('[enkrypt-guardrail] log-only output scan failed unexpectedly', {
          ...logFields,
          error: errorMessage(error),
        });
        return notScanned;
      });

    const waitStartedAt = performance.now();
    const { verdict, usageRecords } = await blockingResult;
    const addedLatencyMs = Math.round(performance.now() - waitStartedAt);
    return {
      decision:
        verdict.action === 'allow' || verdict.action === 'skip'
          ? ({ action: 'release', response: replayedResponse(response, buffered) } as const)
          : reject(asResponseVerdict(verdict)),
      usageRecords: logOnlyResult.then(logOnlyScan =>
        outputUsageRecords(usageRecords, logOnlyScan.usageRecords, addedLatencyMs)
      ),
    };
  })();
  after(scanned.then(({ usageRecords }) => usageRecords).then(recordEnkryptUsageRecords));

  const released = scanned.then(({ decision }) => finish(decision));
  if (!stream || format !== 'sse') return released;
  void released.catch(() => {});
  return streamOnceDecided(response, released);
}
