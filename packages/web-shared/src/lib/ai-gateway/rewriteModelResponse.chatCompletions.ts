import type { ProviderResponseTransforms } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getOutputHeaders } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import type {
  ChatCompletionChunk,
  OpenRouterUsage,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { applyReasoningDetailsResponseTransform } from '@kilocode/web-shared/lib/ai-gateway/reasoning-details-transform';
import {
  createStreamProgressLogger,
  logTerminalStreamEvent,
  partialCapturedBody,
  readResponseText,
  rewriteSseStream,
  rewriteUsage,
  type RewriteResponseParams,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.shared';
import type { EventSourceMessage } from 'eventsource-parser';
import { createParser } from 'eventsource-parser';
import { NextResponse } from 'next/server';
import type OpenAI from 'openai';

export type RewriteChatCompletionsResponseParams = RewriteResponseParams & {
  responseTransforms: ProviderResponseTransforms | null;
};

export async function rewriteModelResponse_ChatCompletions({
  response,
  removeCost,
  capture,
  reasoningEffort,
  vercelRequestId,
  responseTransforms,
}: RewriteChatCompletionsResponseParams) {
  const headers = getOutputHeaders(response);

  if (headers.get('content-type')?.includes('application/json')) {
    // Read the body text once to avoid "Response body object should not be
    // disturbed or locked" errors that occur when `.clone().json()` fails.
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
    for (const choice of json.choices ?? []) {
      // Some APIs set null here, which @openrouter/ai-sdk-provider rejects in non-streaming responses
      if (choice.message?.tool_calls === null) {
        delete choice.message.tool_calls;
      }
      applyReasoningDetailsResponseTransform(responseTransforms, choice.message);
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
            if (delta.tool_calls === null) {
              delete delta.tool_calls;
            }
            for (const toolCall of delta.tool_calls ?? []) {
              // Some APIs set null on argument continuation chunks, which @openrouter/ai-sdk-provider rejects
              if (toolCall.type === null) {
                delete toolCall.type;
              }
            }
            applyReasoningDetailsResponseTransform(responseTransforms, delta);
          }

          if (!json.choices) {
            // Some APIs leave this out when returning usage, which is not accepted by OpenCode
            json.choices = [];
          }

          // Vertex managed models attach metadata-only usage to intermediate chunks.
          if (json.usage && typeof json.usage.prompt_tokens !== 'number') {
            delete json.usage;
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
