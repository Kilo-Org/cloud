import 'server-only';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { EventSourceParserStream } from 'eventsource-parser/stream';

export function boundedBody(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  let bytes = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024) throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE' });
        controller.enqueue(chunk);
      },
    }),
    { signal }
  );
}
const StreamEnvelope = z.object({ error: z.unknown().optional() });
// Match @ai-sdk/openai-compatible's unexported chunk schema. Forward the original
// JSON after validation so unknown provider extensions remain intact.
const StreamEvent = z.object({
  id: z.string().nullish(),
  created: z.number().nullish(),
  model: z.string().nullish(),
  choices: z.array(
    z.object({
      delta: z
        .object({
          role: z.enum(['assistant', '']).nullish(),
          content: z.string().nullish(),
          reasoning_content: z.string().nullish(),
          reasoning: z.string().nullish(),
          tool_calls: z
            .array(
              z.object({
                index: z.number().nullish(),
                id: z.string().nullish(),
                function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }),
                extra_content: z
                  .object({
                    google: z.object({ thought_signature: z.string().nullish() }).nullish(),
                  })
                  .nullish(),
              })
            )
            .nullish(),
        })
        .nullish(),
      finish_reason: z.string().nullish(),
    })
  ),
  usage: z
    .object({
      prompt_tokens: z.number().nullish(),
      completion_tokens: z.number().nullish(),
      total_tokens: z.number().nullish(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().nullish() }).nullish(),
      completion_tokens_details: z
        .object({
          reasoning_tokens: z.number().nullish(),
          accepted_prediction_tokens: z.number().nullish(),
          rejected_prediction_tokens: z.number().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});
const StreamError = z.object({ code: z.coerce.number().int().min(400).max(599) });
export const mediaType = (headers: Headers) =>
  headers.get('content-type')?.split(';')[0].trim().toLowerCase();

type StreamContext = {
  signal: AbortSignal;
  abort: AbortController;
  // Keep the caller's sanitized error contract without importing its authority dependencies.
  failure: (status: number) => unknown;
  errorStatus: (error: unknown, invalid: number) => number;
};
export async function streamHarnessModel(
  response: Response,
  headers: Headers,
  { signal, abort, failure, errorStatus }: StreamContext
) {
  const requestId = response.headers.get('request-id');
  if (requestId) headers.set('request-id', requestId);
  if (!response.ok || mediaType(response.headers) !== 'text/event-stream' || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    const status = response.ok ? 422 : response.status;
    return Response.json(failure(status), { status, headers });
  }
  const reader = boundedBody(response.body, signal)
    .pipeThrough(new TextDecoderStream('utf-8', { fatal: true }))
    .pipeThrough(new EventSourceParserStream())
    .getReader();
  const encoder = new TextEncoder();
  let cancelled = false;
  const close = async () => {
    abort.abort();
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  };
  headers.set('content-type', 'text/event-stream');
  headers.set('content-encoding', 'identity');
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) {
            controller.close();
            await close();
            return;
          }
          let data = value.data;
          let terminal = data === '[DONE]';
          if (!terminal) {
            const json: unknown = JSON.parse(data);
            const parsed = StreamEnvelope.parse(json);
            if (parsed.error != null || value.event === 'error') {
              const error = StreamError.safeParse(parsed.error);
              data = JSON.stringify(failure(error.success ? error.data.code : 422));
              terminal = true;
            } else {
              StreamEvent.parse(json);
              data = JSON.stringify(json);
            }
          }
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
          if (terminal) {
            controller.close();
            await close();
          }
        } catch (error) {
          if (!cancelled) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(failure(errorStatus(error, 422)))}\n\n`)
            );
            controller.close();
          }
          await close();
        }
      },
      async cancel() {
        cancelled = true;
        await close();
      },
    }),
    { headers }
  );
}
