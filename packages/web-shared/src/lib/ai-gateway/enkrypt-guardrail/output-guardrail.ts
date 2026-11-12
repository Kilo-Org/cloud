import 'server-only';

import { after, NextResponse } from 'next/server';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import {
  ENKRYPT_GUARDRAIL_TIMEOUT_MS,
  ENKRYPT_MAX_SCAN_CHARACTERS,
  scanRequest,
  type EnkryptGuardrailScan,
  type EnkryptGuardrailScanResult,
  type EnkryptGuardrailVerdict,
  type EnkryptScanCoverage,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detect';
import {
  guardrailSettings,
  type EnkryptOutputGuardrailReport,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import {
  recordEnkryptUsageRecords,
  usageRecordsWithAddedLatency,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/input-guardrail';
import {
  extractResponseText,
  type ResponseBodyFormat,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/response-text';
import { enkryptOutputGuardrailRejectionResponse } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/responses';
import {
  resolveEnkryptOutputGuardrail,
  splitEnkryptInputGuardrail,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import type {
  EnkryptGuardrailCall,
  EnkryptUsageRecord,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/usage';
import type { GatewayChatApiKind } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getOutputHeaders } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { ENKRYPT_API_KEY } from '@kilocode/web-shared/lib/config.server';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { EnkryptRequestLog } from '@kilocode/web-shared/lib/r2/api-request-log';

/** The request a response scan belongs to. The scanned text is the response. */
export type EnkryptOutputScan = Omit<EnkryptGuardrailScan, 'text' | 'coverage'>;

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

export const RESPONSE_TOO_LARGE_MESSAGE = `Your organization's Enkrypt AI guardrail cannot scan more than ${ENKRYPT_MAX_SCAN_CHARACTERS.toLocaleString('en-US')} characters of model output at once, so this response was withheld. ${SHORTER_RESPONSE_ADVICE}`;

type OutputScanResult = Omit<EnkryptGuardrailScanResult, 'report'>;

const outputTooLarge: OutputScanResult = {
  verdict: { action: 'block', message: RESPONSE_TOO_LARGE_MESSAGE },
  usageRecords: [],
};

/**
 * A response is scanned in one call, so one longer than a call can hold is blocked without a scan.
 * Checking it here, rather than leaving it to `scanRequest`, words the block for the response and
 * records why the output was not scanned.
 */
function isTooLargeToScan(text: string): boolean {
  return text.length > ENKRYPT_MAX_SCAN_CHARACTERS;
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

const notScanned: OutputScanResult = {
  verdict: { action: 'skip' },
  usageRecords: [],
};

/** A response is scanned whole; output scans never use the verdict cache. */
function wholeResponseCoverage(text: string): EnkryptScanCoverage {
  return {
    part: 'response',
    cache: 'off',
    totalCharacters: text.length,
    totalSegments: text.length > 0 ? 1 : 0,
    cachedCharacters: 0,
    cachedSegments: 0,
    omittedAttachments: 0,
  };
}

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

function recordOutputUsageRecords(usageRecords: EnkryptUsageRecord[]): Promise<void> {
  return recordEnkryptUsageRecords(usageRecords, { guardrail: 'output' });
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
  /** Receives the guardrail's report, to read after the response like `after()` work. */
  captureReport?: (report: () => Promise<EnkryptOutputGuardrailReport>) => void;
  captureRequestLogs?: (logs: (captureResponse?: boolean) => Promise<EnkryptRequestLog[]>) => void;
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
  captureReport,
  captureRequestLogs,
}: GuardEnkryptOutputParams): Promise<NextResponse> {
  // Upstream error bodies are not model output.
  if (!scan || !response.ok || !response.body) return release(response);
  const { body } = response;
  const { blocking, logOnly } = splitEnkryptInputGuardrail(scan.config);
  const format = bodyFormat(response);
  const requestLogs: Promise<EnkryptRequestLog>[] = [];
  const captureResponse = Promise.withResolvers<boolean>();
  const deps = {
    apiKey: ENKRYPT_API_KEY,
    fetch,
    timeoutMs: ENKRYPT_GUARDRAIL_TIMEOUT_MS,
    signal,
    requestLog: captureRequestLogs && {
      guardrail: 'output' as const,
      capture: (entry: Promise<EnkryptRequestLog>) => {
        requestLogs.push(entry);
      },
      captureResponse: captureResponse.promise,
    },
  };
  const logFields = {
    guardrail: 'output',
    organization_id: scan.organizationId,
    session_id: scan.sessionId,
    client_request_id: scan.clientRequestId,
    api_kind: scan.apiKind,
  };
  const report: EnkryptOutputGuardrailReport = {
    settings: guardrailSettings(scan.config),
    held_back: blocking !== null,
    held_bytes: null,
    held_ms: null,
    upstream_read_failed: false,
    output_characters: null,
    not_scanned_reason: null,
    verdict: 'skip',
    unavailable_reason: null,
    added_latency_ms: null,
    scans: [],
  };
  const scanOutput = async (
    config: EnkryptOutputScan['config'],
    text: string
  ): Promise<OutputScanResult> => {
    const result = await scanRequest(
      { ...scan, config, text, coverage: wholeResponseCoverage(text) },
      deps
    );
    report.scans.push(result.report);
    return result;
  };
  const finish = async (decision: OutputDecision): Promise<NextResponse> => {
    if (decision.action === 'release') return release(decision.response);
    await onReject(decision.response, decision.verdict);
    return decision.response;
  };
  const decide = (verdict: EnkryptGuardrailVerdict, allowed: Response): OutputDecision => {
    report.verdict = verdict.action;
    report.unavailable_reason = verdict.action === 'unavailable' ? verdict.reason : null;
    if (verdict.action === 'allow' || verdict.action === 'skip') {
      return { action: 'release', response: allowed };
    }
    warnExceptInTest('[enkrypt-guardrail] output withheld', {
      ...logFields,
      verdict: verdict.action,
      reason: report.unavailable_reason ?? report.not_scanned_reason ?? undefined,
    });
    return {
      action: 'reject',
      response: enkryptOutputGuardrailRejectionResponse(kind, verdict, stream),
      verdict,
    };
  };
  const finalReport = (): EnkryptOutputGuardrailReport => ({
    ...report,
    scans: report.scans.toSorted(
      (a, b) => Number(a.scan !== 'blocking') - Number(b.scan !== 'blocking')
    ),
  });
  const notScannedBecause = (reason: EnkryptOutputGuardrailReport['not_scanned_reason']) => {
    report.not_scanned_reason = reason;
    warnExceptInTest('[enkrypt-guardrail] output not scanned', { ...logFields, reason });
  };

  if (!blocking) {
    const copy = logOnly && response.clone().body;
    if (logOnly && copy) {
      const scanned = (async () => {
        try {
          const copied = await readBody(copy);
          report.upstream_read_failed = copied.readError !== null;
          if (copied.overLimit) return notScannedBecause('held_output_too_large');
          const text = extractResponseText(kind, format, bodyText(copied));
          report.output_characters = text.length;
          if (isTooLargeToScan(text)) return notScannedBecause('output_too_large');
          const result = await scanOutput(logOnly, text);
          return outputUsageRecords([], result.usageRecords, 0);
        } catch (error) {
          console.error('[enkrypt-guardrail] log-only output scan failed unexpectedly', {
            ...logFields,
            error: errorMessage(error),
          });
        }
      })();
      const logged = scanned.then(records => recordOutputUsageRecords(records ?? []));
      after(logged);
      captureRequestLogs?.(async (shouldCaptureResponse = true) => {
        captureResponse.resolve(shouldCaptureResponse);
        await scanned;
        return Promise.all(requestLogs);
      });
      captureReport?.(async () => {
        await logged;
        return finalReport();
      });
    }
    return release(response);
  }

  if (scan.config.status === 'invalid') {
    void body.cancel().catch(() => {});
    report.held_back = false;
    notScannedBecause('invalid_config');
    captureReport?.(async () => finalReport());
    return finish(decide({ action: 'unavailable', reason: 'failed' }, response));
  }

  const scanned = (async () => {
    const bufferStartedAt = performance.now();
    const buffered = await readBody(body);
    report.held_ms = Math.round(performance.now() - bufferStartedAt);
    report.held_bytes = bufferedBytes(buffered);
    report.upstream_read_failed = buffered.readError !== null;
    console.debug('[enkrypt-guardrail] output held back', {
      ...logFields,
      held_ms: report.held_ms,
      held_bytes: report.held_bytes,
      read_failed: report.upstream_read_failed,
      over_limit: buffered.overLimit,
    });
    if (buffered.overLimit) {
      notScannedBecause('held_output_too_large');
      return {
        decision: decide({ action: 'block', message: HELD_OUTPUT_TOO_LARGE_MESSAGE }, response),
        usageRecords: Promise.resolve([]),
      };
    }

    const text = Promise.resolve().then(() => {
      const extracted = extractResponseText(kind, format, bodyText(buffered));
      report.output_characters = extracted.length;
      if (isTooLargeToScan(extracted)) notScannedBecause('output_too_large');
      return extracted;
    });
    const blockingResult = text
      .then(scannedText =>
        isTooLargeToScan(scannedText) ? outputTooLarge : scanOutput(blocking, scannedText)
      )
      .catch((error: unknown): OutputScanResult => {
        console.error('[enkrypt-guardrail] output scan failed unexpectedly; response withheld', {
          ...logFields,
          error: errorMessage(error),
        });
        return {
          verdict: { action: 'unavailable', reason: 'failed' },
          usageRecords: [],
        };
      });
    const logOnlyResult = text
      .then(scannedText =>
        logOnly && !isTooLargeToScan(scannedText) ? scanOutput(logOnly, scannedText) : notScanned
      )
      .catch((error: unknown): OutputScanResult => {
        console.error('[enkrypt-guardrail] log-only output scan failed unexpectedly', {
          ...logFields,
          error: errorMessage(error),
        });
        return notScanned;
      });

    const waitStartedAt = performance.now();
    const { verdict, usageRecords } = await blockingResult;
    const addedLatencyMs = Math.round(performance.now() - waitStartedAt);
    report.added_latency_ms = addedLatencyMs;
    return {
      decision: decide(verdict, replayedResponse(response, buffered)),
      usageRecords: logOnlyResult.then(logOnlyScan =>
        outputUsageRecords(usageRecords, logOnlyScan.usageRecords, addedLatencyMs)
      ),
    };
  })();
  const recorded = scanned.then(({ usageRecords }) => usageRecords).then(recordOutputUsageRecords);
  after(recorded);
  captureRequestLogs?.(async (shouldCaptureResponse = true) => {
    captureResponse.resolve(shouldCaptureResponse);
    const { usageRecords } = await scanned;
    await usageRecords;
    return Promise.all(requestLogs);
  });
  captureReport?.(async () => {
    await recorded;
    return finalReport();
  });

  const released = scanned.then(({ decision }) => finish(decision));
  if (!stream || format !== 'sse') return released;
  void released.catch(() => {});
  return streamOnceDecided(response, released);
}
