import { isKiloExclusiveFreeModel, shouldRedactModelNameInResponse } from '@/lib/ai-gateway/models';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';
import { getOutputHeaders } from '@/lib/ai-gateway/llm-proxy-helpers';
import type { ChatCompletionChunk, OpenRouterUsage } from '@/lib/ai-gateway/processUsage.types';
import type { EventSourceMessage } from 'eventsource-parser';
import { createParser } from 'eventsource-parser';
import { NextResponse } from 'next/server';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';

function rewriteUsage(usage: OpenRouterUsage) {
  // We only rewrite the response for free models, strip upstream cost
  delete usage.cost;
  delete usage.cost_details;
  delete usage.is_byok;
  if (usage.prompt_tokens_details) {
    if (usage.prompt_tokens_details.cached_tokens === undefined) {
      usage.prompt_tokens_details.cached_tokens = 0; // OpenCode crashes if this is absent
    }
  }
}

function createRewrittenSseStream<T>(
  body: ReadableStream<Uint8Array> | null,
  rewriteJson: (json: T) => void
): ReadableStream<Uint8Array> {
  const reader = body?.getReader() ?? null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let outputController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let doneReceived = false;
  let cancelled = false;
  let finished = false;
  let released = false;
  let enqueueCount = 0;

  const release = () => {
    if (!reader || released) return;
    released = true;
    reader.releaseLock();
  };
  const enqueue = (value: string) => {
    if (cancelled || !outputController) return;
    outputController.enqueue(encoder.encode(value));
    enqueueCount++;
  };
  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (event.data === '[DONE]') {
        doneReceived = true;
        return;
      }

      const json = JSON.parse(event.data) as T;
      rewriteJson(json);
      const idLine = event.id === undefined ? '' : `id: ${event.id}\n`;
      const eventLine = event.event ? `event: ${event.event}\n` : '';
      enqueue(`${idLine}${eventLine}data: ${JSON.stringify(json)}\n\n`);
    },
    onComment() {
      enqueue(': KILO PROCESSING\n\n');
    },
  });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      outputController = controller;
      if (!reader) {
        finished = true;
        controller.close();
      }
    },
    async pull(controller) {
      if (!reader || finished || cancelled) return;

      try {
        const enqueueCountBeforePull = enqueueCount;
        while (!finished && !cancelled && enqueueCount === enqueueCountBeforePull) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (!done) {
            parser.feed(decoder.decode(value, { stream: true }));
            continue;
          }

          finished = true;
          const finalText = decoder.decode();
          if (finalText) parser.feed(finalText);
          // Be permissive at EOF and dispatch a complete final data line even
          // when the upstream omitted its trailing blank SSE delimiter.
          parser.feed('\n\n');
          if (doneReceived) enqueue('data: [DONE]\n\n');
          release();
          controller.close();
        }
      } catch (error) {
        finished = true;
        release();
        if (!cancelled) controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      finished = true;
      if (reader) {
        void reader
          .cancel(reason)
          .catch(() => undefined)
          .finally(release);
      }
    },
  });
}

export async function rewriteFreeModelResponse_ChatCompletions(response: Response, model: string) {
  const headers = getOutputHeaders(response);

  if (headers.get('content-type')?.includes('application/json')) {
    // Read the body text once to avoid "Response body object should not be
    // disturbed or locked" errors that occur when `.clone().json()` fails.
    const text = await response.text();
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
    if (json.model) {
      json.model = model;
    }

    const usage = json.usage as OpenRouterUsage;
    if (usage) {
      rewriteUsage(usage);
    }

    return NextResponse.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const stream = createRewrittenSseStream<ChatCompletionChunk>(response.body, json => {
    if (json.model) {
      json.model = model;
    }

    const delta = json.choices?.[0]?.delta;
    if (delta?.role === null) {
      // Some APIs set null here, which is not accepted by OpenCode
      delete delta.role;
    }

    if (!json.choices) {
      // Some APIs leave this out when returning usage, which is not accepted by OpenCode
      json.choices = [];
    }

    if (json.usage) {
      rewriteUsage(json.usage);
    }
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

function rewriteMessagesUsage(usage: MessagesApiUsage) {
  delete usage.cost;
  delete usage.cost_details;
  delete usage.is_byok;
}

export async function rewriteFreeModelResponse_Messages(response: Response, model: string) {
  const headers = getOutputHeaders(response);

  if (headers.get('content-type')?.includes('application/json')) {
    const text = await response.text();
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
    if (json.model) {
      json.model = model;
    }
    if (json.usage) {
      rewriteMessagesUsage(json.usage);
    }
    return NextResponse.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const stream = createRewrittenSseStream<
    MessagesApiMessageStart | MessagesApiMessageDelta | Anthropic.Messages.MessageStreamEvent
  >(response.body, json => {
    if (json.type === 'message_start') {
      const event = json as MessagesApiMessageStart;
      if (event.message.model) {
        event.message.model = model;
      }
      if (event.message.usage) {
        rewriteMessagesUsage(event.message.usage);
      }
    }

    if (json.type === 'message_delta') {
      const event = json as MessagesApiMessageDelta;
      if (event.usage) {
        rewriteMessagesUsage(event.usage);
      }
    }
  });

  return new NextResponse(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

type ResponsesApiEvent = {
  type: string;
  response?: OpenAI.Responses.Response & { usage?: OpenRouterUsage | null };
};

export async function rewriteFreeModelResponse_Responses(response: Response, model: string) {
  const headers = getOutputHeaders(response);

  if (headers.get('content-type')?.includes('application/json')) {
    const text = await response.text();
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
    if (json.model) {
      json.model = model;
    }
    if (json.usage) {
      rewriteUsage(json.usage);
    }
    return NextResponse.json(json, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  const stream = createRewrittenSseStream<ResponsesApiEvent>(response.body, json => {
    if (json.response) {
      if (json.response.model) {
        json.response.model = model;
      }
      if (json.response.usage) {
        rewriteUsage(json.response.usage);
      }
    }
  });

  return new NextResponse(stream, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function rewriteFreeModelResponse(
  response: Response,
  model: string,
  providerId: ProviderId,
  kind: GatewayRequest['kind']
): Promise<NextResponse | null> {
  const isFreeModelRequiringCostRemoval =
    (providerId === 'openrouter' || providerId === 'vercel') && isKiloExclusiveFreeModel(model);

  if (!isFreeModelRequiringCostRemoval && !shouldRedactModelNameInResponse(providerId, model)) {
    return null;
  }

  if (kind === 'chat_completions') {
    return rewriteFreeModelResponse_ChatCompletions(response, model);
  }
  if (kind === 'responses') {
    return rewriteFreeModelResponse_Responses(response, model);
  }
  if (kind === 'messages') {
    return rewriteFreeModelResponse_Messages(response, model);
  }

  return null;
}
