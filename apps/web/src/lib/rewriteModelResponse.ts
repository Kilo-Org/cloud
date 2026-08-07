import { api_request_log, type User } from '@kilocode/db/schema';
import { isKiloExclusiveFreeModel } from '@/lib/ai-gateway/models';
import { getCustomPricing } from '@/lib/ai-gateway/custom-pricing';
import { detectToolCallArgumentErrors } from '@/lib/ai-gateway/api-request-log-errors';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { ProviderId, ProviderResponseTransforms } from '@/lib/ai-gateway/providers/types';
import { getOutputHeaders } from '@/lib/ai-gateway/llm-proxy-helpers';
import type { ChatCompletionChunk, OpenRouterUsage } from '@/lib/ai-gateway/processUsage.types';
import { isDynamicallyOptedIntoRequestLogging } from '@/lib/ai-gateway/request-logging-opt-ins';
import { db } from '@/lib/drizzle';
import { KILO_ORGANIZATION_ID } from '@/lib/organizations/constants';
import { errorExceptInTest, logExceptInTest } from '@/lib/utils.server';
import { withRequestId } from '@/lib/ai-gateway/request-id';
import { sanitizeJsonbValue } from '@/lib/sanitize-jsonb';
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
  setBody(text: string): void;
  setReadError(error: unknown, partialBody?: string): void;
};

export type RequestLoggingParams = {
  user: User | null;
  organization_id: string | null;
  session_id: string | null;
  vercel_request_id: string | null;
  request: GatewayRequest;
};

type CapturedResponseBody =
  | { text: string; readError?: never }
  | { readError: string; text?: string };

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
  response: Response,
  model: string,
  provider: string,
  logging: RequestLoggingParams
): Promise<RequestLogCapture | null> {
  const { user, organization_id, session_id, vercel_request_id, request } = logging;
  if (!(await isLoggingEnabledForUser(user, organization_id))) {
    return null;
  }
  const status = response.status;

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
      const error =
        responseText !== undefined
          ? responseReadError !== undefined
            ? {
                ...(detectToolCallArgumentErrors(responseText, request) ?? {}),
                response_body_read_error: responseReadError,
              }
            : detectToolCallArgumentErrors(responseText, request)
          : { response_body_read_error: responseReadError };
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
          request: sanitizeJsonbValue(request.body),
          response: responseText,
          error: sanitizeJsonbValue(error),
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
    setBody: text => settleOnce({ text }),
    setReadError: (error, partialBody) =>
      settleOnce(
        partialBody !== undefined && partialBody.length > 0
          ? { text: partialBody, readError: String(error).substring(0, 4000) }
          : { readError: String(error).substring(0, 4000) }
      ),
  };
}

/** For paths where the upstream response is not passed through rewriteModelResponse. */
export async function logUnrewrittenResponse(
  response: Response,
  model: string,
  providerId: ProviderId,
  logging: RequestLoggingParams
): Promise<void> {
  const capture = await createRequestLogCapture(response, model, providerId, logging);
  if (!capture) {
    return;
  }
  try {
    capture.setBody(await response.text());
  } catch (error) {
    capture.setReadError(error);
  }
}

type ResponseReadError = {
  errorType: 'timeout' | 'upstream_disconnect';
  /** Already carries the request id suffix when one is available. */
  message: string;
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
        'The upstream response was interrupted while streaming. The provider may have disconnected or the request may have timed out.',
        vercelRequestId
      ),
    };
  }

  if (error.name === 'TimeoutError') {
    return {
      errorType: 'timeout',
      message: withRequestId(
        'The upstream provider timed out while sending the response.',
        vercelRequestId
      ),
    };
  }

  return null;
}

async function readResponseText(
  response: Response,
  headers: Headers,
  vercelRequestId: string | null | undefined,
  capture: RequestLogCapture | null
): Promise<{ text: string } | { error: unknown; errorResponse: NextResponse }> {
  try {
    return { text: await response.text() };
  } catch (error) {
    const responseReadError = getResponseReadError(error, vercelRequestId);
    if (!responseReadError) {
      // Settle the capture so the after() callback awaiting it does not hang
      // and the request is still logged (without a response body).
      capture?.setReadError(error);
      throw error;
    }

    return {
      error,
      errorResponse: NextResponse.json(
        {
          error: responseReadError.message,
          error_type: responseReadError.errorType,
          message: responseReadError.message,
        },
        { status: 503, headers }
      ),
    };
  }
}

function partialCapturedBody(capturedChunks: string[] | null): string | undefined {
  return capturedChunks && capturedChunks.length > 0 ? capturedChunks.join('') : undefined;
}

async function rewriteSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  parser: ReturnType<typeof createParser>,
  controller: ReadableStreamDefaultController<string>,
  doneReceived: () => boolean,
  terminalEventReceived: () => boolean,
  serializeError: (error: ResponseReadError) => string,
  onFinally: () => void,
  vercelRequestId: string | null | undefined,
  capture: RequestLogCapture | null,
  capturedChunks: string[] | null
) {
  const decoder = new TextDecoder();
  const settleReadError = (error: unknown) =>
    capture?.setReadError(error, partialCapturedBody(capturedChunks));
  const settleBody = () => {
    if (capturedChunks) {
      capturedChunks.push(decoder.decode());
      capture?.setBody(capturedChunks.join(''));
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any event left buffered when the stream ends without a
        // trailing blank line, so its data isn't silently dropped.
        parser.reset({ consume: true });
        if (doneReceived()) {
          controller.enqueue('data: [DONE]\n\n');
        }
        controller.close();
        settleBody();
        return;
      }
      const chunk = decoder.decode(value, { stream: true });
      capturedChunks?.push(chunk);
      parser.feed(chunk);
      if (terminalEventReceived()) {
        if (doneReceived()) {
          controller.enqueue('data: [DONE]\n\n');
        }
        const cancellation = reader.cancel();
        controller.close();
        settleBody();
        try {
          await cancellation;
        } catch (error) {
          errorExceptInTest(
            '[rewriteModelResponse] failed to cancel terminal upstream stream',
            error
          );
        }
        return;
      }
    }
  } catch (error) {
    const responseReadError = getResponseReadError(error, vercelRequestId);
    if (!responseReadError) {
      settleReadError(error);
      throw error;
    }

    errorExceptInTest('[rewriteModelResponse] emitting stream error event', {
      ...responseReadError,
      vercelRequestId: vercelRequestId ?? '<none>',
    });
    settleReadError(error);
    controller.enqueue(serializeError(responseReadError));
    controller.close();
  } finally {
    onFinally();
    reader.releaseLock();
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPropertyPath(target: unknown, path: string): unknown {
  let current = target;
  for (const segment of path.split('.')) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function rewriteThoughtContent(delta: unknown, path: string) {
  if (
    !isRecord(delta) ||
    typeof delta.content !== 'string' ||
    getPropertyPath(delta, path) !== true
  ) {
    return;
  }

  delta.reasoning_content = delta.content;
  delete delta.content;
}

export async function rewriteModelResponse_ChatCompletions(
  response: Response,
  removeCost: boolean,
  capture: RequestLogCapture | null,
  vercelRequestId: string | null,
  responseTransforms: ProviderResponseTransforms | null = null
) {
  const headers = getOutputHeaders(response);

  if (headers.get('content-type')?.includes('application/json')) {
    // Read the body text once to avoid "Response body object should not be
    // disturbed or locked" errors that occur when `.clone().json()` fails.
    const textResult = await readResponseText(response, headers, vercelRequestId, capture);
    if ('errorResponse' in textResult) {
      capture?.setReadError(textResult.error);
      return textResult.errorResponse;
    }
    capture?.setBody(textResult.text);
    const { text } = textResult;
    let json: OpenAI.ChatCompletion;
    try {
      json = JSON.parse(text) as OpenAI.ChatCompletion;
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

  // Accumulate the raw upstream text for request logging while the stream is
  // being processed anyway, so it doesn't have to be processed a second time.
  // Shared with the stream's cancel() callback so a client disconnect still
  // logs the partially received response body.
  const capturedChunks: string[] | null = capture ? [] : null;
  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        capture?.setBody('');
        return;
      }

      let doneReceived = false;
      let terminalEventReceived = false;
      let generationId: string | undefined;
      const progress = createStreamProgressLogger();
      const parser = createParser({
        onEvent(event: EventSourceMessage) {
          if (doneReceived || terminalEventReceived) {
            return;
          }
          progress.eventProcessed();
          if (event.data === '[DONE]') {
            logTerminalStreamEvent('chat_completions', event.data, generationId, vercelRequestId);
            doneReceived = true;
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

          for (const choice of json.choices ?? []) {
            const delta = choice.delta;
            if (!delta) {
              continue;
            }
            // Some APIs set null here, which is not accepted by OpenCode
            if (delta.role === null) {
              delete delta.role;
            }
            if (responseTransforms?.thoughtContentMapping) {
              rewriteThoughtContent(delta, responseTransforms.thoughtContentMapping);
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
          terminalEventReceived = 'error' in json && json.error != null;
          if (terminalEventReceived) {
            logTerminalStreamEvent('chat_completions', 'error', generationId, vercelRequestId);
          }
        },
        onComment() {
          if (doneReceived || terminalEventReceived) {
            return;
          }
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });

      await rewriteSseStream(
        reader,
        parser,
        controller,
        () => doneReceived,
        () => doneReceived || terminalEventReceived,
        responseReadError =>
          'data: ' +
          JSON.stringify({
            ...(generationId ? { id: generationId } : {}),
            error: {
              code: 503,
              message: responseReadError.message,
              type: responseReadError.errorType,
            },
          }) +
          '\n\n',
        progress.stop,
        vercelRequestId,
        capture,
        capturedChunks
      );
    },
    cancel() {
      capture?.setReadError(
        new Error('response stream was cancelled'),
        partialCapturedBody(capturedChunks)
      );
    },
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

  if (headers.get('content-type')?.includes('application/json')) {
    const textResult = await readResponseText(response, headers, vercelRequestId, capture);
    if ('errorResponse' in textResult) {
      capture?.setReadError(textResult.error);
      return textResult.errorResponse;
    }
    capture?.setBody(textResult.text);
    const { text } = textResult;
    let json: Anthropic.Messages.Message & { usage?: MessagesApiUsage };
    try {
      json = JSON.parse(text) as Anthropic.Messages.Message & {
        usage?: MessagesApiUsage;
      };
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

  // Accumulate the raw upstream text for request logging while the stream is
  // being processed anyway, so it doesn't have to be processed a second time.
  // Shared with the stream's cancel() callback so a client disconnect still
  // logs the partially received response body.
  const capturedChunks: string[] | null = capture ? [] : null;
  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        capture?.setBody('');
        return;
      }

      let doneReceived = false;
      let terminalEventReceived = false;
      let generationId: string | undefined;
      const progress = createStreamProgressLogger();
      const parser = createParser({
        onEvent(event: EventSourceMessage) {
          if (doneReceived || terminalEventReceived) {
            return;
          }
          progress.eventProcessed();
          if (event.data === '[DONE]') {
            logTerminalStreamEvent('messages', event.data, generationId, vercelRequestId);
            doneReceived = true;
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
          terminalEventReceived = json.type === 'message_stop' || json.type === 'error';
          if (terminalEventReceived) {
            logTerminalStreamEvent('messages', json.type, generationId, vercelRequestId);
          }
        },
        onComment() {
          if (doneReceived || terminalEventReceived) {
            return;
          }
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });

      await rewriteSseStream(
        reader,
        parser,
        controller,
        () => doneReceived,
        () => doneReceived || terminalEventReceived,
        responseReadError =>
          'event: error\n' +
          'data: ' +
          JSON.stringify({
            ...(generationId ? { id: generationId } : {}),
            type: 'error',
            error: {
              type: 'api_error',
              message: responseReadError.message,
              error_type: responseReadError.errorType,
            },
          }) +
          '\n\n',
        progress.stop,
        vercelRequestId,
        capture,
        capturedChunks
      );
    },
    cancel() {
      capture?.setReadError(
        new Error('response stream was cancelled'),
        partialCapturedBody(capturedChunks)
      );
    },
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

  if (headers.get('content-type')?.includes('application/json')) {
    const textResult = await readResponseText(response, headers, vercelRequestId, capture);
    if ('errorResponse' in textResult) {
      capture?.setReadError(textResult.error);
      return textResult.errorResponse;
    }
    capture?.setBody(textResult.text);
    const { text } = textResult;
    let json: OpenAI.Responses.Response & { usage?: OpenRouterUsage | null };
    try {
      json = JSON.parse(text) as OpenAI.Responses.Response & {
        usage?: OpenRouterUsage | null;
      };
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

  // Accumulate the raw upstream text for request logging while the stream is
  // being processed anyway, so it doesn't have to be processed a second time.
  // Shared with the stream's cancel() callback so a client disconnect still
  // logs the partially received response body.
  const capturedChunks: string[] | null = capture ? [] : null;
  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        capture?.setBody('');
        return;
      }

      let doneReceived = false;
      let terminalEventReceived = false;
      let generationId: string | undefined;
      let nextSequenceNumber = 0;
      const progress = createStreamProgressLogger();
      const parser = createParser({
        onEvent(event: EventSourceMessage) {
          if (doneReceived || terminalEventReceived) {
            return;
          }
          progress.eventProcessed();
          if (event.data === '[DONE]') {
            logTerminalStreamEvent('responses', event.data, generationId, vercelRequestId);
            doneReceived = true;
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
          terminalEventReceived =
            json.type === 'response.completed' ||
            json.type === 'response.incomplete' ||
            json.type === 'response.failed' ||
            json.type === 'error';
          if (terminalEventReceived) {
            logTerminalStreamEvent('responses', json.type, generationId, vercelRequestId);
          }
        },
        onComment() {
          if (doneReceived || terminalEventReceived) {
            return;
          }
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });

      await rewriteSseStream(
        reader,
        parser,
        controller,
        () => doneReceived,
        () => doneReceived || terminalEventReceived,
        responseReadError =>
          'event: error\n' +
          'data: ' +
          JSON.stringify({
            ...(generationId ? { id: generationId } : {}),
            type: 'error',
            sequence_number: nextSequenceNumber,
            error: {
              type: responseReadError.errorType,
              code: responseReadError.errorType === 'timeout' ? '504' : '503',
              message: responseReadError.message,
            },
          }) +
          '\n\n',
        progress.stop,
        vercelRequestId,
        capture,
        capturedChunks
      );
    },
    cancel() {
      capture?.setReadError(
        new Error('response stream was cancelled'),
        partialCapturedBody(capturedChunks)
      );
    },
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
  logging: RequestLoggingParams,
  responseTransforms: ProviderResponseTransforms | null = null
): Promise<NextResponse> {
  const capture = await createRequestLogCapture(response, model, providerId, logging);
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
      vercelRequestId,
      responseTransforms
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
