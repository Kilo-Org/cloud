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
  const queuedOutput: Uint8Array[] = [];
  let decodedInput = '';
  let doneReceived = false;
  let doneOutputQueued = false;
  let upstreamDone = false;
  let cancelled = false;
  let finished = false;
  let released = false;

  const release = () => {
    if (!reader || released) return;
    released = true;
    reader.releaseLock();
  };
  const queueOutput = (value: string) => {
    if (!cancelled) queuedOutput.push(encoder.encode(value));
  };
  const takeNextInputLine = (): string | null => {
    for (let index = 0; index < decodedInput.length; index++) {
      const character = decodedInput[index];
      if (character === '\n') {
        const line = decodedInput.slice(0, index + 1);
        decodedInput = decodedInput.slice(index + 1);
        return line;
      }
      if (character !== '\r') continue;
      if (index + 1 === decodedInput.length && !upstreamDone) return null;

      const lineEnd = decodedInput[index + 1] === '\n' ? index + 2 : index + 1;
      const line = decodedInput.slice(0, lineEnd);
      decodedInput = decodedInput.slice(lineEnd);
      return line;
    }
    return null;
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
      queueOutput(`${idLine}${eventLine}data: ${JSON.stringify(json)}\n\n`);
    },
    onComment() {
      queueOutput(': KILO PROCESSING\n\n');
    },
  });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!reader) {
        finished = true;
        controller.close();
      }
    },
    async pull(controller) {
      if (!reader || finished || cancelled) return;

      try {
        while (queuedOutput.length === 0 && !finished && !cancelled) {
          const nextLine = takeNextInputLine();
          if (nextLine !== null) {
            parser.feed(nextLine);
            continue;
          }

          if (!upstreamDone) {
            const { done, value } = await reader.read();
            if (cancelled) return;
            if (!done) {
              decodedInput += decoder.decode(value, { stream: true });
              continue;
            }

            upstreamDone = true;
            decodedInput += decoder.decode();
            // Be permissive at EOF and dispatch a complete final data line even
            // when the upstream omitted its trailing blank SSE delimiter.
            decodedInput += '\n\n';
            release();
            continue;
          }

          if (doneReceived && !doneOutputQueued) {
            doneOutputQueued = true;
            queueOutput('data: [DONE]\n\n');
            continue;
          }

          finished = true;
          controller.close();
        }

        const nextOutput = queuedOutput.shift();
        if (nextOutput) controller.enqueue(nextOutput);
      } catch (error) {
        finished = true;
        queuedOutput.length = 0;
        decodedInput = '';
        release();
        if (!cancelled) controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      finished = true;
      queuedOutput.length = 0;
      decodedInput = '';
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
