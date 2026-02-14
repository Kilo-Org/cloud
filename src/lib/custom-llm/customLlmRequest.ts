import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';
import { createAnthropic } from '@ai-sdk/anthropic';
import { streamText, type TextStreamPart, type ToolSet } from 'ai';
import { NextResponse } from 'next/server';
import type { OpenRouterChatCompletionsInput } from './openrouter-chat-completions-input';
import type { OpenRouterStreamChatCompletionChunkSchema } from './schemas';
import type * as z from 'zod';

function convertMessages(messages: OpenRouterChatCompletionsInput) {
  return [];
}

type ChatCompletionChunk = z.infer<typeof OpenRouterStreamChatCompletionChunkSchema>;

function convertStreamPartToChunk(part: TextStreamPart<ToolSet>): ChatCompletionChunk {
  return {};
}

export async function customModelRequest(
  requestedModel: string,
  request: OpenRouterChatCompletionRequest
) {
  const provider = createAnthropic({
    apiKey: 'placeholder',
  });

  const model = provider('placeholder');

  const result = streamText({
    model,
    messages: convertMessages(request.messages as OpenRouterChatCompletionsInput),
  });

  const stream = new ReadableStream({
    async start(controller) {
      for await (const chunk of result.fullStream) {
        controller.enqueue(`data: ${JSON.stringify(convertStreamPartToChunk(chunk))}\n\n`);
      }

      controller.enqueue('data: [DONE]\n\n');
      controller.close();
    },
  });

  return new NextResponse(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}
