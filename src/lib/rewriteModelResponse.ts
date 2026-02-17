import { ReasoningDetailType } from '@/lib/custom-llm/reasoning-details';
import { getOutputHeaders } from '@/lib/llm-proxy-helpers';
import type { MessageWithReasoning } from '@/lib/providers/openrouter/types';
import type { EventSourceMessage } from 'eventsource-parser';
import { createParser } from 'eventsource-parser';
import { NextResponse } from 'next/server';
import type OpenAI from 'openai';

function convertReasoningToOpenRouterFormat(message: MessageWithReasoning) {
  if (!message.reasoning_content) {
    return;
  }
  if (!message.reasoning) {
    message.reasoning = message.reasoning_content;
  }
  if (!message.reasoning_details) {
    message.reasoning_details = [
      {
        type: ReasoningDetailType.Text,
        text: message.reasoning_content,
      },
    ];
  }
  delete message.reasoning_content;
}

export async function rewriteModelResponse(response: Response, model: string) {
  const headers = getOutputHeaders(response);

  if (headers.get('content-type')?.includes('application/json')) {
    const json = (await response.json()) as OpenAI.ChatCompletion;
    if (json.model) {
      json.model = model;
    }

    const message = json.choices?.[0]?.message;
    if (message) {
      convertReasoningToOpenRouterFormat(message as MessageWithReasoning);
    }
    return NextResponse.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      const parser = createParser({
        onEvent(event: EventSourceMessage) {
          if (event.data === '[DONE]') {
            return;
          }
          const json = JSON.parse(event.data) as OpenAI.ChatCompletionChunk;
          if (json.model) {
            json.model = model;
          }

          const delta = json.choices?.[0]?.delta;
          if (delta) {
            // Some APIs set null here, which is not accepted by OpenCode
            if (delta?.role === null) {
              delete delta.role;
            }

            convertReasoningToOpenRouterFormat(delta as MessageWithReasoning);
          }

          controller.enqueue('data: ' + JSON.stringify(json) + '\n\n');
        },
      });

      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue('data: [DONE]\n\n');
          controller.close();
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    },
  });

  return new NextResponse(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
