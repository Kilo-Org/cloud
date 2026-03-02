import type { OpenRouterChatCompletionRequest } from '@kilocode/llm-shared';
import { isKiloStealthModel, kiloFreeModels, ReasoningDetailType } from '@kilocode/llm-shared';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { getOutputHeaders } from '../responses.js';
import { logger } from '../logger.js';

type MessageWithReasoning = {
  reasoning_content?: string;
  reasoning?: string;
  reasoning_details?: unknown[];
  [key: string]: unknown;
};

type OpenRouterUsage = {
  cost?: number;
  cost_details?: unknown;
  is_byok?: boolean | null;
  [key: string]: unknown;
};

type ChatCompletionChunk = {
  model?: string;
  choices?: {
    delta?: MessageWithReasoning & { role?: string | null };
    [key: string]: unknown;
  }[];
  usage?: OpenRouterUsage;
  [key: string]: unknown;
};

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

function removeCostInfo(usage: OpenRouterUsage) {
  delete usage.cost;
  delete usage.cost_details;
  delete usage.is_byok;
}

export async function rewriteFreeModelResponse(
  response: Response,
  model: string
): Promise<Response> {
  const headers = getOutputHeaders(response);

  if (headers.get('content-type')?.includes('application/json')) {
    const json = (await response.json()) as Record<string, unknown>;
    if (json.model) {
      json.model = model;
    }

    const choices = json.choices as { message?: MessageWithReasoning }[] | undefined;
    const message = choices?.[0]?.message;
    if (message) {
      convertReasoningToOpenRouterFormat(message);
    }

    const usage = json.usage as OpenRouterUsage | undefined;
    if (usage) {
      removeCostInfo(usage);
    }

    return Response.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // Streaming SSE response
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
          const json = JSON.parse(event.data) as ChatCompletionChunk;
          if (json.model) {
            json.model = model;
          }

          const delta = json.choices?.[0]?.delta;
          if (delta) {
            // Some APIs set null here, which is not accepted by OpenCode
            if (delta.role === null) {
              delete delta.role;
            }
            convertReasoningToOpenRouterFormat(delta);
          }

          if (!json.choices) {
            // Some APIs leave this out when returning usage, which is not accepted by OpenCode
            json.choices = [];
          }

          if (json.usage) {
            removeCostInfo(json.usage);
          }

          controller.enqueue('data: ' + JSON.stringify(json) + '\n\n');
        },
        onComment() {
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          break;
        }
        parser.feed(decoder.decode(value, { stream: true }));
      }
    },
  });

  // The ReadableStream start() enqueues strings via the parser callbacks but
  // also uses encoder.encode for the final [DONE]. We need a TransformStream
  // to handle mixed string/Uint8Array - simpler to just encode everything.
  const encoder = new TextEncoder();
  const encodingTransform = new TransformStream<string | Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (typeof chunk === 'string') {
        controller.enqueue(encoder.encode(chunk));
      } else {
        controller.enqueue(chunk);
      }
    },
  });

  return new Response(stream.pipeThrough(encodingTransform), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const byokErrorMessages: Record<number, string> = {
  401: '[BYOK] Your API key is invalid or has been revoked. Please check your API key configuration.',
  402: '[BYOK] Your API account has insufficient funds. Please check your billing details with your API provider.',
  403: '[BYOK] Your API key does not have permission to access this resource. Please check your API key permissions.',
  429: '[BYOK] Your API key has hit its rate limit. Please try again later or check your rate limit settings with your API provider.',
};

function estimateTokenCount(request: OpenRouterChatCompletionRequest) {
  return Math.round(
    JSON.stringify(request).length / 4 + (request.max_completion_tokens ?? request.max_tokens ?? 0)
  );
}

export async function makeErrorReadable({
  requestedModel,
  request,
  response,
  isUserByok,
}: {
  requestedModel: string;
  request: OpenRouterChatCompletionRequest;
  response: Response;
  isUserByok: boolean;
}): Promise<Response | undefined> {
  if (response.status < 400) {
    return undefined;
  }

  if (isUserByok) {
    const byokMessage = byokErrorMessages[response.status];
    if (byokMessage) {
      logger.warn(`Responding with ${response.status} ${byokMessage}`);
      return Response.json(
        { error: byokMessage, message: byokMessage },
        { status: response.status }
      );
    }
  }

  // Sometimes we get generic or nonsensical errors when the context length is exceeded
  // (such as "Internal Server Error" or "No allowed providers are available for the selected model")
  const model = kiloFreeModels.find(m => m.public_id === requestedModel);
  if (model) {
    const estimatedTokenCount = estimateTokenCount(request);
    if (estimatedTokenCount >= model.context_length) {
      const error = `The maximum context length is ${model.context_length} tokens. However, about ${estimatedTokenCount} tokens were requested.`;
      logger.warn(`Responding with ${response.status} ${error}`);
      return Response.json({ error, message: error }, { status: response.status });
    }
  }

  if (isKiloStealthModel(requestedModel)) {
    const error = 'Stealth model unable to process request';
    logger.warn(`Responding with ${response.status} ${error}`);
    return Response.json({ error, message: error }, { status: response.status });
  }

  return undefined;
}
