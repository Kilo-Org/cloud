import { getOutputHeaders } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import type { OpenRouterUsage } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  createStreamProgressLogger,
  logTerminalStreamEvent,
  partialCapturedBody,
  readResponseText,
  rewriteSseStream,
  rewriteUsage,
  rewriteResponseMetadata,
  type ResponseMetadata,
  type RewriteResponseParams,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.shared';
import type { EventSourceMessage } from 'eventsource-parser';
import { createParser } from 'eventsource-parser';
import { NextResponse } from 'next/server';
import type OpenAI from 'openai';

type ResponsesApiEvent = {
  type: string;
  sequence_number?: number;
  response?: OpenAI.Responses.Response & ResponseMetadata & { usage?: OpenRouterUsage | null };
  item?: unknown;
} & ResponseMetadata;

// Bedrock mantle names completed output item IDs `item_id` instead of `id`.
function restoreResponsesOutputItemId(item: unknown) {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return;
  if (!('id' in item) && 'item_id' in item && typeof item.item_id === 'string') {
    Object.assign(item, { id: item.item_id });
  }
}

export async function rewriteModelResponse_Responses({
  response,
  usageContext,
  capture,
  reasoningEffort,
  vercelRequestId,
}: RewriteResponseParams) {
  const headers = getOutputHeaders(response);

  if (headers.get('content-type')?.includes('application/json')) {
    const textResult = await readResponseText(
      response,
      headers,
      vercelRequestId,
      capture,
      reasoningEffort
    );
    if ('errorResponse' in textResult) {
      capture?.setReadError(textResult.error);
      return textResult.errorResponse;
    }
    capture?.setBody(textResult.text);
    const { text } = textResult;
    let json: OpenAI.Responses.Response & ResponseMetadata & { usage?: OpenRouterUsage | null };
    try {
      json = JSON.parse(text) as OpenAI.Responses.Response &
        ResponseMetadata & {
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
      rewriteUsage(json.usage, usageContext, json.provider_metadata ?? json.providerMetadata);
    }
    rewriteResponseMetadata(json, usageContext);
    for (const item of Array.isArray(json.output) ? json.output : []) {
      restoreResponsesOutputItemId(item);
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
  const stream = new ReadableStream<string>({
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
      let providerMetadata: ResponseMetadata['provider_metadata'];
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
          restoreResponsesOutputItemId(json.item);
          for (const item of json.response?.output ?? []) {
            restoreResponsesOutputItemId(item);
          }
          if (json.response) {
            providerMetadata =
              json.response.provider_metadata ?? json.response.providerMetadata ?? providerMetadata;
            if (generationId === undefined && json.response.id) {
              generationId = json.response.id;
              logExceptInTest('[rewriteModelResponse] received generation ID', {
                kind: 'responses',
                generationId,
              });
            }
            if (json.response.usage) {
              rewriteUsage(json.response.usage, usageContext, providerMetadata);
            }
            rewriteResponseMetadata(json.response, usageContext);
          }
          rewriteResponseMetadata(json, usageContext);
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
        () => progress.stop(),
        vercelRequestId,
        capture,
        capturedChunks,
        reasoningEffort
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
