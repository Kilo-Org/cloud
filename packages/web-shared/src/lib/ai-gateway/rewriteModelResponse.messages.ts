import { getOutputHeaders } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  createStreamProgressLogger,
  logTerminalStreamEvent,
  partialCapturedBody,
  readResponseText,
  rewriteSseStream,
  type RewriteResponseParams,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.shared';
import type { EventSourceMessage } from 'eventsource-parser';
import { createParser } from 'eventsource-parser';
import { NextResponse } from 'next/server';
import type Anthropic from '@anthropic-ai/sdk';

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

export async function rewriteModelResponse_Messages({
  response,
  removeCost,
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
