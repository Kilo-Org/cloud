import { api_request_log, type User } from '@kilocode/db/schema';
import { isKiloExclusiveFreeModel } from '@/lib/ai-gateway/models';
import { getCustomPricing } from '@/lib/ai-gateway/custom-pricing';
import {
  detectToolCallArgumentErrors,
  type ApiRequestLogError,
} from '@/lib/ai-gateway/api-request-log-errors';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';
import { getOutputHeaders } from '@/lib/ai-gateway/llm-proxy-helpers';
import type { ChatCompletionChunk, OpenRouterUsage } from '@/lib/ai-gateway/processUsage.types';
import { isDynamicallyOptedIntoRequestLogging } from '@/lib/ai-gateway/request-logging-opt-ins';
import { db } from '@/lib/drizzle';
import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';
import { errorExceptInTest, logExceptInTest } from '@/lib/utils.server';
import { withRequestId } from '@/lib/ai-gateway/request-id';
import type { EventSourceMessage } from 'eventsource-parser';
import { createParser } from 'eventsource-parser';
import { after, NextResponse } from 'next/server';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * Handle passed to the response pipeline so the upstream response body can be
 * captured for request logging while the response is being processed anyway.
 * This way the event stream is only processed once, instead of once for
 * logging and once for rewriting.
 */
export type RequestLogCapture = {
  setBody(text: string, error?: RequestLogError): void;
  setReadError(error: unknown, partialBody?: string, details?: RequestLogError): void;
  setError(error: RequestLogError): void;
};

export type RequestLoggingParams = {
  user: User | null;
  organization_id: string | null;
  session_id: string | null;
  vercel_request_id: string | null;
  request: GatewayRequest;
};

type RequestLogError = Omit<
  ApiRequestLogError,
  'invalid_tool_call_arguments' | 'response_body_read_error'
>;

type CapturedResponseBody = {
  text?: string;
  readError?: string;
  error?: RequestLogError;
};

async function isLoggingEnabledForUser(
  user: User | null,
  organizationId: string | null
): Promise<boolean> {
  if (user?.google_user_email.endsWith('@kilo.ai')) return true;
  if (user?.google_user_email.endsWith('@kilocode.ai')) return true;
  if (organizationId === KILO_ORGANIZATION_ID) return true;
  return isDynamicallyOptedIntoRequestLogging({
    accountId: user?.id ?? null,
    organizationId,
  });
}

async function createRequestLogCapture(
  status: number,
  model: string,
  provider: string,
  logging: RequestLoggingParams
): Promise<RequestLogCapture | null> {
  const { user, organization_id, session_id, vercel_request_id, request } = logging;
  if (!(await isLoggingEnabledForUser(user, organization_id))) {
    return null;
  }
  let resolveCaptured: (result: CapturedResponseBody) => void = () => {};
  const captured = new Promise<CapturedResponseBody>(resolve => {
    resolveCaptured = resolve;
  });
  let isSettled = false;
  const settleOnce = (result: CapturedResponseBody) => {
    if (!isSettled) {
      isSettled = true;
      resolveCaptured(result);
    }
  };

  after(async () => {
    // Wait until the response pipeline has processed the response body. This
    // resolves when the response stream completes (or fails), which happens
    // before after() callbacks are awaited.
    const result = await captured;
    const responseText = 'text' in result ? result.text : undefined;
    const responseReadError = 'readError' in result ? result.readError : undefined;
    if (responseReadError !== undefined) {
      logExceptInTest(
        `[rewriteModelResponse] failed to read response body (user=${user?.id}, status=${status}, model=${model}): ${responseReadError}`
      );
    }
    try {
      const detectedToolCallErrors =
        responseText !== undefined && responseReadError === undefined
          ? detectToolCallArgumentErrors(responseText, request)
          : null;
      const errorDetails = {
        ...(detectedToolCallErrors ?? {}),
        ...(result.error ?? {}),
        ...(responseReadError !== undefined && {
          response_body_read_error: responseReadError,
        }),
      };
      const error = Object.keys(errorDetails).length > 0 ? errorDetails : undefined;
      const apiRequestLogId = await db
        .insert(api_request_log)
        .values({
          kilo_user_id: user?.id,
          organization_id,
          session_id,
          vercel_request_id,
          status_code: status,
          model,
          provider,
          request: request.body,
          response: responseText,
          error,
        })
        .returning({ id: api_request_log.id });
      logExceptInTest(
        '[rewriteModelResponse] Inserted into api_request_log',
        apiRequestLogId[0].id
      );
    } catch (e) {
      const cause = e instanceof Error ? e.cause : undefined;
      logExceptInTest(
        `[rewriteModelResponse] failed to insert api_request_log (user=${user?.id}, status=${status}, model=${model}) cause (truncated): ${String(cause).substring(0, 4000)} error (truncated): ${String(e).substring(0, 4000)}`
      );
    }
  });

  return {
    setBody: (text, error) => settleOnce({ text, error }),
    setReadError: (error, partialBody, details) =>
      settleOnce(
        partialBody !== undefined && partialBody.length > 0
          ? { text: partialBody, readError: String(error).substring(0, 4000), error: details }
          : { readError: String(error).substring(0, 4000), error: details }
      ),
    setError: error => settleOnce({ error }),
  };
}

/** For paths where the upstream response is not passed through rewriteModelResponse. */
export async function logUnrewrittenResponse(
  response: Response,
  model: string,
  providerId: ProviderId,
  logging: RequestLoggingParams
): Promise<void> {
  const capture = await createRequestLogCapture(response.status, model, providerId, logging);
  if (!capture) {
    return;
  }
  void captureUnrewrittenResponse(response, capture);
}

async function captureUnrewrittenResponse(
  response: Response,
  capture: RequestLogCapture
): Promise<void> {
  try {
    capture.setBody(await response.text());
  } catch (error) {
    capture.setReadError(error);
  }
}

export async function logUpstreamRequestFailure(
  status: number,
  model: string,
  providerId: ProviderId,
  logging: RequestLoggingParams
): Promise<void> {
  const capture = await createRequestLogCapture(status, model, providerId, logging);
  capture?.setError({ upstream_request_error: 'fetch_failed' });
}

type ResponseReadError = {
  errorType: 'timeout' | 'upstream_disconnect' | 'invalid_response';
  /** Already carries the request id suffix when one is available. */
  message: string;
  vercelRequestId?: string;
};

const STREAM_PROGRESS_LOG_INTERVAL_MS = 30_000;

function createStreamProgressLogger() {
  let eventCount = 0;
  const interval = setInterval(() => {
    logExceptInTest('[rewriteModelResponse] stream progress', {
      eventCount,
    });
  }, STREAM_PROGRESS_LOG_INTERVAL_MS);

  return {
    eventProcessed() {
      eventCount += 1;
    },
    stop() {
      clearInterval(interval);
    },
  };
}

function logTerminalStreamEvent(
  kind: GatewayRequest['kind'],
  eventType: string,
  generationId: string | undefined,
  vercelRequestId: string | null | undefined
) {
  logExceptInTest('[rewriteModelResponse] received terminal stream event', {
    kind,
    eventType,
    generationId: generationId ?? '<none>',
    vercelRequestId: vercelRequestId ?? '<none>',
  });
}

function getResponseReadError(
  error: unknown,
  vercelRequestId: string | null | undefined
): ResponseReadError | null {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return null;
  }

  if (error.name === 'ResponseAborted') {
    return {
      errorType: 'upstream_disconnect',
      message: withRequestId(
        'The upstream provider disconnected while sending the response.',
        vercelRequestId
      ),
      vercelRequestId: vercelRequestId ?? undefined,
    };
  }

  if (error.name === 'TimeoutError') {
    return {
      errorType: 'timeout',
      message: withRequestId(
        'The upstream provider timed out while sending the response.',
        vercelRequestId
      ),
      vercelRequestId: vercelRequestId ?? undefined,
    };
  }

  return null;
}

function invalidResponseReadError(vercelRequestId: string | null | undefined): ResponseReadError {
  return {
    errorType: 'invalid_response',
    message: withRequestId('The upstream provider returned an invalid response.', vercelRequestId),
    vercelRequestId: vercelRequestId ?? undefined,
  };
}

async function readResponseText(
  response: Response,
  vercelRequestId: string | null | undefined
): Promise<{ text: string } | { error: unknown; responseReadError: ResponseReadError }> {
  try {
    return { text: await response.text() };
  } catch (error) {
    return {
      error,
      responseReadError:
        getResponseReadError(error, vercelRequestId) ?? invalidResponseReadError(vercelRequestId),
    };
  }
}

function isJsonContentType(contentType: string | null): boolean {
  const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

function isEventStreamContentType(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0].trim().toLowerCase() === 'text/event-stream';
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function passThroughResponse(
  response: Response,
  headers: Headers,
  capture: RequestLogCapture | null
): NextResponse {
  let body = response.body;
  if (!body) {
    capture?.setBody('');
  } else if (capture) {
    body = createCapturedPassThroughBody(body, capture);
  }
  return new NextResponse(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createCapturedPassThroughBody(
  upstreamBody: ReadableStream<Uint8Array<ArrayBuffer>>,
  capture: RequestLogCapture
): ReadableStream<Uint8Array<ArrayBuffer>> {
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | null = null;
  const decoder = new TextDecoder();
  const capturedChunks: string[] = [];
  let finalized = false;

  const flushCapture = () => {
    if (finalized) return;
    finalized = true;
    const trailingText = decoder.decode();
    if (trailingText) capturedChunks.push(trailingText);
  };
  const releaseReader = (activeReader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>) => {
    try {
      activeReader.releaseLock();
    } catch (error) {
      errorExceptInTest('[rewriteModelResponse] failed to release passthrough reader', error);
    }
  };
  const cancelReader = (reason: unknown) => {
    const activeReader = reader;
    reader = null;
    if (!activeReader) return;
    let cancellation: Promise<void>;
    try {
      cancellation = activeReader.cancel(reason);
    } catch (error) {
      errorExceptInTest('[rewriteModelResponse] failed to cancel passthrough stream', error);
      releaseReader(activeReader);
      return;
    }
    queueMicrotask(() => releaseReader(activeReader));
    void cancellation.catch(error => {
      errorExceptInTest('[rewriteModelResponse] failed to cancel passthrough stream', error);
    });
  };

  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      try {
        reader = upstreamBody.getReader();
      } catch (error) {
        flushCapture();
        capture.setReadError(error);
        controller.error(error);
      }
    },
    async pull(controller) {
      const activeReader = reader;
      if (!activeReader || finalized) return;
      try {
        const { done, value } = await activeReader.read();
        if (finalized) return;
        if (done) {
          flushCapture();
          capture.setBody(capturedChunks.join(''));
          reader = null;
          releaseReader(activeReader);
          controller.close();
          return;
        }
        capturedChunks.push(decoder.decode(value, { stream: true }));
        controller.enqueue(value);
      } catch (error) {
        if (finalized) return;
        flushCapture();
        capture.setReadError(error, partialCapturedBody(capturedChunks));
        reader = null;
        releaseReader(activeReader);
        controller.error(error);
      }
    },
    cancel(reason) {
      flushCapture();
      capture.setReadError(
        new Error('response stream was cancelled'),
        partialCapturedBody(capturedChunks),
        { client_disconnected: true }
      );
      cancelReader(reason);
    },
  });
}

function partialCapturedBody(capturedChunks: string[] | null): string | undefined {
  return capturedChunks && capturedChunks.length > 0 ? capturedChunks.join('') : undefined;
}

type TerminalStreamEvent = {
  eventType: string;
  isError: boolean;
};

function createRewrittenSseStream({
  response,
  createEventParser,
  doneReceived,
  getTerminalEvent,
  serializeError,
  onFinally,
  vercelRequestId,
  capture,
  capturedChunks,
}: {
  response: Response;
  createEventParser: (
    controller: ReadableStreamDefaultController<string>
  ) => ReturnType<typeof createParser>;
  doneReceived: () => boolean;
  getTerminalEvent: () => TerminalStreamEvent | null;
  serializeError: (error: ResponseReadError) => string;
  onFinally: () => void;
  vercelRequestId: string | null | undefined;
  capture: RequestLogCapture | null;
  capturedChunks: string[] | null;
}): ReadableStream<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let parser: ReturnType<typeof createParser> | null = null;
  const decoder = new TextDecoder();
  let decoderFlushed = false;
  let finalized = false;

  const flushDecoder = () => {
    if (decoderFlushed) return '';
    decoderFlushed = true;
    const trailingText = decoder.decode();
    if (trailingText) capturedChunks?.push(trailingText);
    return trailingText;
  };
  const settleReadError = (error: unknown, responseReadError: ResponseReadError) => {
    flushDecoder();
    capture?.setReadError(error, partialCapturedBody(capturedChunks), {
      gateway_stream_error: { error_type: responseReadError.errorType },
    });
  };
  const settleBody = (terminalEvent: TerminalStreamEvent | null) => {
    flushDecoder();
    if (capturedChunks) {
      const text = capturedChunks.join('');
      if (terminalEvent?.isError) {
        capture?.setBody(text, {
          upstream_stream_error: { event_type: terminalEvent.eventType },
        });
      } else {
        capture?.setBody(text);
      }
    }
  };

  const releaseReader = (activeReader: ReadableStreamDefaultReader<Uint8Array>) => {
    try {
      activeReader.releaseLock();
    } catch (error) {
      errorExceptInTest('[rewriteModelResponse] failed to release upstream stream reader', error);
    }
  };
  const finalize = (activeReader?: ReadableStreamDefaultReader<Uint8Array>) => {
    if (finalized) return;
    finalized = true;
    onFinally();
    if (activeReader) releaseReader(activeReader);
  };
  const cancelUpstream = (reason: unknown) => {
    const activeReader = reader;
    reader = null;
    if (!activeReader) {
      finalize();
      return;
    }

    let cancellation: Promise<void>;
    try {
      cancellation = activeReader.cancel(reason);
    } catch (error) {
      errorExceptInTest('[rewriteModelResponse] failed to cancel upstream stream', error);
      finalize(activeReader);
      return;
    }

    finalize();
    queueMicrotask(() => releaseReader(activeReader));
    void cancellation.catch(error => {
      errorExceptInTest('[rewriteModelResponse] failed to cancel upstream stream', error);
    });
  };
  const emitReadError = (controller: ReadableStreamDefaultController<string>, error: unknown) => {
    const responseReadError =
      getResponseReadError(error, vercelRequestId) ?? invalidResponseReadError(vercelRequestId);
    errorExceptInTest('[rewriteModelResponse] emitting stream error event', {
      ...responseReadError,
      vercelRequestId: vercelRequestId ?? '<none>',
    });
    settleReadError(error, responseReadError);
    controller.enqueue(serializeError(responseReadError));
    controller.close();
    cancelUpstream(error);
  };

  return new ReadableStream<string>({
    start(controller) {
      try {
        reader = response.body?.getReader() ?? null;
        if (!reader) {
          controller.close();
          capture?.setBody('');
          finalize();
          return;
        }
        parser = createEventParser(controller);
      } catch (error) {
        emitReadError(controller, error);
      }
    },
    async pull(controller) {
      const activeReader = reader;
      const activeParser = parser;
      if (finalized || !activeReader || !activeParser) return;

      try {
        const { done, value } = await activeReader.read();
        if (finalized) return;
        if (done) {
          const trailingText = flushDecoder();
          if (trailingText) activeParser.feed(trailingText);
          // Complete the final SSE record even when upstream omitted its blank line.
          activeParser.feed('\n\n');
          if (doneReceived()) {
            controller.enqueue('data: [DONE]\n\n');
          }
          controller.close();
          settleBody(getTerminalEvent());
          reader = null;
          finalize(activeReader);
          return;
        }

        const chunk = decoder.decode(value, { stream: true });
        capturedChunks?.push(chunk);
        activeParser.feed(chunk);
        const terminalEvent = getTerminalEvent();
        if (!terminalEvent) return;
        if (doneReceived()) {
          controller.enqueue('data: [DONE]\n\n');
        }
        controller.close();
        settleBody(terminalEvent);
        cancelUpstream('terminal stream event received');
      } catch (error) {
        if (!finalized) emitReadError(controller, error);
      }
    },
    cancel(reason) {
      flushDecoder();
      capture?.setReadError(
        new Error('response stream was cancelled'),
        partialCapturedBody(capturedChunks),
        { client_disconnected: true }
      );
      cancelUpstream(reason);
    },
  });
}

function rewriteUsage(usage: OpenRouterUsage, removeCost: boolean) {
  if (removeCost) {
    delete usage.cost;
    delete usage.cost_details;
    delete usage.is_byok;
  }
  if (usage.prompt_tokens_details) {
    if (usage.prompt_tokens_details.cached_tokens === undefined) {
      usage.prompt_tokens_details.cached_tokens = 0; // OpenCode crashes if this is absent
    }
  }
}

export async function rewriteModelResponse_ChatCompletions(
  response: Response,
  removeCost: boolean,
  capture: RequestLogCapture | null,
  vercelRequestId: string | null
) {
  const headers = getOutputHeaders(response);
  const contentType = response.headers.get('content-type');

  if (isJsonContentType(contentType)) {
    // Read the body text once to avoid "Response body object should not be
    // disturbed or locked" errors that occur when `.clone().json()` fails.
    const textResult = await readResponseText(response, vercelRequestId);
    if ('responseReadError' in textResult) {
      capture?.setReadError(textResult.error, undefined, {
        gateway_stream_error: { error_type: textResult.responseReadError.errorType },
      });
      return NextResponse.json(
        {
          error: {
            code: 503,
            message: textResult.responseReadError.message,
            type: textResult.responseReadError.errorType,
            param: null,
            ...(textResult.responseReadError.vercelRequestId && {
              vercel_request_id: textResult.responseReadError.vercelRequestId,
            }),
          },
        },
        { status: 503, headers }
      );
    }
    capture?.setBody(textResult.text);
    const { text } = textResult;
    let json: OpenAI.ChatCompletion;
    try {
      json = JSON.parse(text) as OpenAI.ChatCompletion;
      if (!isJsonObject(json)) throw new TypeError('Expected a JSON object');
    } catch {
      // Upstream returned invalid/empty JSON body — pass through as-is
      return new NextResponse(text, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    const usage = json.usage as OpenRouterUsage;
    if (usage) {
      rewriteUsage(usage, removeCost);
    }

    return NextResponse.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (!isEventStreamContentType(contentType)) {
    return passThroughResponse(response, headers, capture);
  }

  // Accumulate the raw upstream text for request logging while the stream is
  // being processed anyway, so it doesn't have to be processed a second time.
  // Shared with the stream's cancel() callback so a client disconnect still
  // logs the partially received response body.
  const capturedChunks: string[] | null = capture ? [] : null;
  let doneReceived = false;
  let terminalEvent: TerminalStreamEvent | null = null;
  let generationId: string | undefined;
  const progress = createStreamProgressLogger();
  const stream = createRewrittenSseStream({
    response,
    createEventParser(controller) {
      return createParser({
        onEvent(event: EventSourceMessage) {
          if (terminalEvent) {
            return;
          }
          progress.eventProcessed();
          if (event.data === '[DONE]') {
            logTerminalStreamEvent('chat_completions', event.data, generationId, vercelRequestId);
            doneReceived = true;
            terminalEvent = { eventType: event.data, isError: false };
            return;
          }
          const json = JSON.parse(event.data) as ChatCompletionChunk;
          if (generationId === undefined && json.id) {
            generationId = json.id;
            logExceptInTest('[rewriteModelResponse] received generation ID', {
              kind: 'chat_completions',
              generationId,
            });
          }

          const delta = json.choices?.[0]?.delta;
          if (delta) {
            // Some APIs set null here, which is not accepted by OpenCode
            if (delta?.role === null) {
              delete delta.role;
            }
          }

          if (!json.choices) {
            // Some APIs leave this out when returning usage, which is not accepted by OpenCode
            json.choices = [];
          }

          if (json.usage) {
            rewriteUsage(json.usage, removeCost);
          }

          const eventLine = event.event ? 'event: ' + event.event + '\n' : '';
          controller.enqueue(eventLine + 'data: ' + JSON.stringify(json) + '\n\n');
          if ('error' in json && json.error != null) {
            terminalEvent = { eventType: 'error', isError: true };
            logTerminalStreamEvent('chat_completions', 'error', generationId, vercelRequestId);
          }
        },
        onComment() {
          if (terminalEvent) {
            return;
          }
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });
    },
    doneReceived: () => doneReceived,
    getTerminalEvent: () => terminalEvent,
    serializeError: responseReadError =>
      'data: ' +
      JSON.stringify({
        ...(generationId ? { id: generationId } : {}),
        error: {
          code: responseReadError.errorType === 'invalid_response' ? 502 : 503,
          message: responseReadError.message,
          type: responseReadError.errorType,
          ...(responseReadError.vercelRequestId && {
            vercel_request_id: responseReadError.vercelRequestId,
          }),
        },
      }) +
      '\n\n',
    onFinally: progress.stop,
    vercelRequestId,
    capture,
    capturedChunks,
  });

  return new NextResponse(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type MessagesApiUsage = Anthropic.Messages.Usage & {
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
};

type MessagesApiMessageStart = {
  type: 'message_start';
  message: Anthropic.Messages.Message & { usage: MessagesApiUsage };
};

type MessagesApiMessageDelta = {
  type: 'message_delta';
  usage: MessagesApiUsage;
  delta: Anthropic.Messages.MessageDeltaEvent['delta'];
};

type MessagesApiError = {
  type: 'error';
  error: unknown;
};

function rewriteMessagesUsage(usage: MessagesApiUsage, removeCost: boolean) {
  if (removeCost) {
    delete usage.cost;
    delete usage.cost_details;
    delete usage.is_byok;
  }
}

export async function rewriteModelResponse_Messages(
  response: Response,
  removeCost: boolean,
  capture: RequestLogCapture | null,
  vercelRequestId: string | null
) {
  const headers = getOutputHeaders(response);
  const contentType = response.headers.get('content-type');

  if (isJsonContentType(contentType)) {
    const textResult = await readResponseText(response, vercelRequestId);
    if ('responseReadError' in textResult) {
      capture?.setReadError(textResult.error, undefined, {
        gateway_stream_error: { error_type: textResult.responseReadError.errorType },
      });
      return NextResponse.json(
        {
          type: 'error',
          error: {
            type: 'api_error',
            message: textResult.responseReadError.message,
            error_type: textResult.responseReadError.errorType,
          },
        },
        { status: 503, headers }
      );
    }
    capture?.setBody(textResult.text);
    const { text } = textResult;
    let json: Anthropic.Messages.Message & { usage?: MessagesApiUsage };
    try {
      json = JSON.parse(text) as Anthropic.Messages.Message & {
        usage?: MessagesApiUsage;
      };
      if (!isJsonObject(json)) throw new TypeError('Expected a JSON object');
    } catch {
      // Upstream returned invalid/empty JSON body — pass through as-is
      return new NextResponse(text, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (json.usage) {
      rewriteMessagesUsage(json.usage, removeCost);
    }
    return NextResponse.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (!isEventStreamContentType(contentType)) {
    return passThroughResponse(response, headers, capture);
  }

  // Accumulate the raw upstream text for request logging while the stream is
  // being processed anyway, so it doesn't have to be processed a second time.
  // Shared with the stream's cancel() callback so a client disconnect still
  // logs the partially received response body.
  const capturedChunks: string[] | null = capture ? [] : null;
  let doneReceived = false;
  let terminalEvent: TerminalStreamEvent | null = null;
  let generationId: string | undefined;
  const progress = createStreamProgressLogger();
  const stream = createRewrittenSseStream({
    response,
    createEventParser(controller) {
      return createParser({
        onEvent(event: EventSourceMessage) {
          if (terminalEvent) {
            return;
          }
          progress.eventProcessed();
          if (event.data === '[DONE]') {
            logTerminalStreamEvent('messages', event.data, generationId, vercelRequestId);
            doneReceived = true;
            terminalEvent = { eventType: event.data, isError: false };
            return;
          }
          const json = JSON.parse(event.data) as
            | MessagesApiMessageStart
            | MessagesApiMessageDelta
            | MessagesApiError
            | Anthropic.Messages.MessageStreamEvent;

          if (json.type === 'message_start') {
            const e = json as MessagesApiMessageStart;
            if (generationId === undefined && e.message.id) {
              generationId = e.message.id;
              logExceptInTest('[rewriteModelResponse] received generation ID', {
                kind: 'messages',
                generationId,
              });
            }
            if (e.message.usage) {
              rewriteMessagesUsage(e.message.usage, removeCost);
            }
          }

          if (json.type === 'message_delta') {
            const e = json as MessagesApiMessageDelta;
            if (e.usage) {
              rewriteMessagesUsage(e.usage, removeCost);
            }
          }

          const eventLine = event.event ? 'event: ' + event.event + '\n' : '';
          controller.enqueue(eventLine + 'data: ' + JSON.stringify(json) + '\n\n');
          if (json.type === 'message_stop' || json.type === 'error') {
            terminalEvent = { eventType: json.type, isError: json.type === 'error' };
            logTerminalStreamEvent('messages', json.type, generationId, vercelRequestId);
          }
        },
        onComment() {
          if (terminalEvent) {
            return;
          }
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });
    },
    doneReceived: () => doneReceived,
    getTerminalEvent: () => terminalEvent,
    serializeError: responseReadError =>
      'event: error\n' +
      'data: ' +
      JSON.stringify({
        ...(generationId ? { id: generationId } : {}),
        type: 'error',
        error: {
          type: 'api_error',
          message: responseReadError.message,
          error_type: responseReadError.errorType,
          ...(responseReadError.vercelRequestId && {
            vercel_request_id: responseReadError.vercelRequestId,
          }),
        },
      }) +
      '\n\n',
    onFinally: progress.stop,
    vercelRequestId,
    capture,
    capturedChunks,
  });

  return new NextResponse(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type ResponsesApiEvent = {
  type: string;
  sequence_number?: number;
  response?: OpenAI.Responses.Response & { usage?: OpenRouterUsage | null };
};

export async function rewriteModelResponse_Responses(
  response: Response,
  removeCost: boolean,
  capture: RequestLogCapture | null,
  vercelRequestId: string | null
) {
  const headers = getOutputHeaders(response);
  const contentType = response.headers.get('content-type');

  if (isJsonContentType(contentType)) {
    const textResult = await readResponseText(response, vercelRequestId);
    if ('responseReadError' in textResult) {
      capture?.setReadError(textResult.error, undefined, {
        gateway_stream_error: { error_type: textResult.responseReadError.errorType },
      });
      return NextResponse.json(
        {
          error: {
            code: textResult.responseReadError.errorType,
            message: textResult.responseReadError.message,
            param: null,
            type: textResult.responseReadError.errorType,
          },
        },
        { status: 503, headers }
      );
    }
    capture?.setBody(textResult.text);
    const { text } = textResult;
    let json: OpenAI.Responses.Response & { usage?: OpenRouterUsage | null };
    try {
      json = JSON.parse(text) as OpenAI.Responses.Response & {
        usage?: OpenRouterUsage | null;
      };
      if (!isJsonObject(json)) throw new TypeError('Expected a JSON object');
    } catch {
      // Upstream returned invalid/empty JSON body — pass through as-is
      return new NextResponse(text, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    if (json.usage) {
      rewriteUsage(json.usage, removeCost);
    }
    return NextResponse.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (!isEventStreamContentType(contentType)) {
    return passThroughResponse(response, headers, capture);
  }

  // Accumulate the raw upstream text for request logging while the stream is
  // being processed anyway, so it doesn't have to be processed a second time.
  // Shared with the stream's cancel() callback so a client disconnect still
  // logs the partially received response body.
  const capturedChunks: string[] | null = capture ? [] : null;
  let doneReceived = false;
  let terminalEvent: TerminalStreamEvent | null = null;
  let generationId: string | undefined;
  let nextSequenceNumber = 0;
  const progress = createStreamProgressLogger();
  const stream = createRewrittenSseStream({
    response,
    createEventParser(controller) {
      return createParser({
        onEvent(event: EventSourceMessage) {
          if (terminalEvent) {
            return;
          }
          progress.eventProcessed();
          if (event.data === '[DONE]') {
            logTerminalStreamEvent('responses', event.data, generationId, vercelRequestId);
            doneReceived = true;
            terminalEvent = { eventType: event.data, isError: false };
            return;
          }
          const json = JSON.parse(event.data) as ResponsesApiEvent;
          if (json.sequence_number !== undefined) {
            nextSequenceNumber = Math.max(nextSequenceNumber, json.sequence_number + 1);
          }
          if (json.response) {
            if (generationId === undefined && json.response.id) {
              generationId = json.response.id;
              logExceptInTest('[rewriteModelResponse] received generation ID', {
                kind: 'responses',
                generationId,
              });
            }
            if (json.response.usage) {
              rewriteUsage(json.response.usage, removeCost);
            }
          }
          const eventLine = event.event ? 'event: ' + event.event + '\n' : '';
          controller.enqueue(eventLine + 'data: ' + JSON.stringify(json) + '\n\n');
          if (
            json.type === 'response.completed' ||
            json.type === 'response.incomplete' ||
            json.type === 'response.failed' ||
            json.type === 'error'
          ) {
            terminalEvent = {
              eventType: json.type,
              isError: json.type !== 'response.completed',
            };
            logTerminalStreamEvent('responses', json.type, generationId, vercelRequestId);
          }
        },
        onComment() {
          if (terminalEvent) {
            return;
          }
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });
    },
    doneReceived: () => doneReceived,
    getTerminalEvent: () => terminalEvent,
    serializeError: responseReadError =>
      'event: error\n' +
      'data: ' +
      JSON.stringify({
        type: 'error',
        sequence_number: nextSequenceNumber,
        code: responseReadError.errorType,
        message: responseReadError.message,
        param: null,
      }) +
      '\n\n',
    onFinally: progress.stop,
    vercelRequestId,
    capture,
    capturedChunks,
  });

  return new NextResponse(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function rewriteModelResponse(
  response: Response,
  model: string,
  providerId: ProviderId,
  kind: GatewayRequest['kind'],
  logging: RequestLoggingParams
): Promise<NextResponse> {
  const capture = await createRequestLogCapture(response.status, model, providerId, logging);
  const requiresCostRemoval =
    (providerId === 'openrouter' || providerId === 'vercel') &&
    (isKiloExclusiveFreeModel(model) || getCustomPricing(model) !== undefined);

  console.debug('[rewriteModelResponse] rewriting response for %s', model);
  const { vercel_request_id: vercelRequestId } = logging;
  if (kind === 'chat_completions') {
    return rewriteModelResponse_ChatCompletions(
      response,
      requiresCostRemoval,
      capture,
      vercelRequestId
    );
  }
  if (kind === 'responses') {
    return rewriteModelResponse_Responses(response, requiresCostRemoval, capture, vercelRequestId);
  }
  if (kind === 'messages') {
    return rewriteModelResponse_Messages(response, requiresCostRemoval, capture, vercelRequestId);
  }

  const error = new Error(`implementation error: unrecognized API kind ${kind}`);
  capture?.setReadError(error);
  throw error;
}
