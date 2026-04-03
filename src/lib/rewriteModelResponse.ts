import { getOutputHeaders } from '@/lib/llm-proxy-helpers';
import type { ChatCompletionChunk, OpenRouterUsage } from '@/lib/processUsage.types';
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

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      let doneReceived = false;
      const parser = createParser({
        onEvent(event: EventSourceMessage) {
          if (event.data === '[DONE]') {
            doneReceived = true;
            return;
          }
          const json = JSON.parse(event.data) as ChatCompletionChunk;
          if (json.model) {
            json.model = model;
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
            rewriteUsage(json.usage);
          }

          controller.enqueue('data: ' + JSON.stringify(json) + '\n\n');
        },
        onComment() {
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });

      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (doneReceived) {
            controller.enqueue('data: [DONE]\n\n');
          }
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
            // OpenRouter sends [DONE], but this is not standard for Anthropic-style APIs
            return;
          }
          const json = JSON.parse(event.data) as
            | MessagesApiMessageStart
            | MessagesApiMessageDelta
            | Anthropic.Messages.MessageStreamEvent;

          if (json.type === 'message_start') {
            const e = json as MessagesApiMessageStart;
            if (e.message.model) {
              e.message.model = model;
            }
            if (e.message.usage) {
              rewriteMessagesUsage(e.message.usage);
            }
          }

          if (json.type === 'message_delta') {
            const e = json as MessagesApiMessageDelta;
            if (e.usage) {
              rewriteMessagesUsage(e.usage);
            }
          }

          const eventLine = event.event ? 'event: ' + event.event + '\n' : '';
          controller.enqueue(eventLine + 'data: ' + JSON.stringify(json) + '\n\n');
        },
        onComment() {
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });

      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
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

  const stream = new ReadableStream({
    async start(controller) {
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      let doneReceived = false;
      const parser = createParser({
        onEvent(event: EventSourceMessage) {
          if (event.data === '[DONE]') {
            doneReceived = true;
            return;
          }
          const json = JSON.parse(event.data) as ResponsesApiEvent;
          if (json.response) {
            if (json.response.model) {
              json.response.model = model;
            }
            if (json.response.usage) {
              rewriteUsage(json.response.usage);
            }
          }
          controller.enqueue('data: ' + JSON.stringify(json) + '\n\n');
        },
        onComment() {
          controller.enqueue(': KILO PROCESSING\n\n');
        },
      });

      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (doneReceived) {
            controller.enqueue('data: [DONE]\n\n');
          }
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
