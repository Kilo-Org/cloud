import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { z } from 'zod';

/**
 * Upstream providers occasionally answer a streaming chat completion with a 200 whose SSE body is
 * only an envelope: a chunk carrying a generation id, then `[DONE]`, with no content, reasoning,
 * tool call, or refusal delta and no usage payload. Every client then sees a successful request
 * that produced nothing.
 *
 * This module reads ahead in that stream before any byte reaches the client and reports whether
 * the response ever carried content. It never fails a request: bytes read during the peek are
 * replayed in order ahead of the rest of the stream, and any state it cannot classify is reported
 * as `unknown`, which callers forward unchanged.
 */

/** Event cap for one peek. Reaching it settles the peek as `unknown`, so it cannot stall. */
const DEFAULT_MAX_EVENTS = 64;

/**
 * Wall-clock cap for one peek, measured from the first read. Empty envelopes end within a few
 * seconds of their headers, and a longer first-token wait only means the peek forwards the
 * buffered prefix unchanged.
 */
const DEFAULT_MAX_MS = 10_000;

export type UpstreamStreamPeekOutcome =
  /** A content-bearing delta was seen, so the stream is forwarded as usual. */
  | 'content'
  /** The stream ended without any content-bearing delta. */
  | 'empty'
  /** The stream was not recognised, exceeded a cap, or failed while being peeked. */
  | 'unknown';

export type PeekUpstreamStreamOptions = {
  maxEvents?: number;
  maxMs?: number;
  /** Clock, injected so a test can advance past `maxMs` without waiting. */
  now?: () => number;
};

export type PeekedUpstreamStream = {
  /** Number of parsed SSE events read during the peek, excluding `[DONE]`. */
  events: number;
  /** Generation id carried by the first parsed chunk, when the provider sent one. */
  generationId: string | undefined;
  outcome: UpstreamStreamPeekOutcome;
  /** Provider named by the stream itself, when the provider sent one. */
  provider: string | undefined;
  /** The upstream response: the same bytes, prefixed with everything the peek read. */
  response: Response;
};

/**
 * The fields that decide the outcome, and nothing else. Unknown fields, such as usage or
 * provider metadata, pass through untouched, and a delta is read as an open record so an
 * unfamiliar provider shape is forwarded rather than called empty.
 */
const peekChunkSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            delta: z.record(z.string(), z.unknown()).nullish(),
          })
          .passthrough()
      )
      .nullish(),
    error: z.unknown().nullish(),
    id: z.string().nullish(),
    provider: z.string().nullish(),
    provider_name: z.string().nullish(),
  })
  .passthrough();

type PeekChunk = z.infer<typeof peekChunkSchema>;
type PeekDelta = Record<string, unknown>;

/** Whether a delta field carries anything a client can show or act on. */
function valueHasContent(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  // An object field is an output shape this module does not enumerate, such as audio payloads.
  return typeof value === 'object' && value !== null;
}

/**
 * `role` is the only delta field that announces the assistant turn without carrying output.
 * Every other non-empty field counts, including the content, reasoning, refusal and tool-call
 * fields the gateway forwards.
 */
function deltaHasContent(delta: PeekDelta): boolean {
  for (const [key, value] of Object.entries(delta)) {
    if (key === 'role') continue;
    if (valueHasContent(value)) return true;
  }
  return false;
}

function chunkHasContent(chunk: PeekChunk): boolean {
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta;
    if (delta && deltaHasContent(delta)) return true;
  }
  return false;
}

function parseEventData(data: string): PeekChunk | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = peekChunkSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * The upstream reader plus a read the peek started and did not wait for. A peek that hits its
 * deadline while a read is pending hands that read to the replay stream, so the body is never
 * read twice and never abandoned.
 */
type PeekReadState = {
  pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null;
  reader: ReadableStreamDefaultReader<Uint8Array>;
};

async function readNext(state: PeekReadState): Promise<ReadableStreamReadResult<Uint8Array>> {
  const pending = state.pendingRead;
  if (!pending) return await state.reader.read();
  state.pendingRead = null;
  return await pending;
}

/** Settles as `'deadline'` when the peek's remaining time runs out first. */
async function raceDeadline(
  read: Promise<ReadableStreamReadResult<Uint8Array>>,
  deadlineMs: number
): Promise<ReadableStreamReadResult<Uint8Array> | 'deadline'> {
  const { promise: deadline, resolve } = Promise.withResolvers<'deadline'>();
  const timer = setTimeout(resolve, Math.max(0, deadlineMs), 'deadline');
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Replays the bytes the peek already read, then continues the upstream stream. Both the response
 * rewriter and usage accounting pull from this stream, so it stays demand-driven: the peek's
 * buffer is drained one chunk per pull and the upstream reader is only touched after that.
 */
function replayStream(
  state: PeekReadState,
  buffered: readonly Uint8Array[],
  readError: unknown
): ReadableStream<Uint8Array> {
  let bufferedIndex = 0;
  let exhausted = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const bufferedChunk = buffered[bufferedIndex];
      if (bufferedChunk !== undefined) {
        bufferedIndex += 1;
        controller.enqueue(bufferedChunk);
        return;
      }
      if (readError !== undefined) {
        controller.error(readError);
        return;
      }
      if (exhausted) {
        controller.close();
        return;
      }
      try {
        const { done, value } = await readNext(state);
        if (done) {
          exhausted = true;
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await state.reader.cancel(reason);
    },
  });
}

function rebuildResponse(
  response: Response,
  state: PeekReadState,
  buffered: readonly Uint8Array[],
  readError: unknown
): Response {
  // The peek reads the decoded body, so the original encoding and length headers no longer
  // describe it. Downstream output headers are rebuilt from scratch either way.
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(replayStream(state, buffered, readError), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Reads the upstream SSE stream until it carries content, ends, or hits a cap, and returns a
 * response that yields every byte exactly once in the original order.
 */
export async function peekUpstreamStreamForContent(
  response: Response,
  options: PeekUpstreamStreamOptions = {}
): Promise<PeekedUpstreamStream> {
  const contentType = response.headers.get('content-type') ?? '';
  const body = response.body;
  if (!response.ok || !body || !contentType.includes('text/event-stream')) {
    return {
      events: 0,
      generationId: undefined,
      outcome: 'unknown',
      provider: undefined,
      response,
    };
  }

  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const state: PeekReadState = { pendingRead: null, reader: body.getReader() };
  const buffered: Uint8Array[] = [];

  let events = 0;
  let generationId: string | undefined;
  let provider: string | undefined;
  let settled = false;
  let outcome: UpstreamStreamPeekOutcome = 'unknown';
  let readError: unknown;
  const settle = (next: UpstreamStreamPeekOutcome) => {
    if (settled) return;
    settled = true;
    outcome = next;
  };

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (settled) return;
      if (event.data === '[DONE]') {
        settle('empty');
        return;
      }
      const chunk = parseEventData(event.data);
      if (!chunk) {
        // A shape this peek does not model cannot be called empty.
        settle('unknown');
        return;
      }
      events += 1;
      generationId ??= chunk.id ?? undefined;
      provider ??= chunk.provider ?? chunk.provider_name ?? undefined;
      // An error frame is the answer: retrying it would hide the failure the client must read.
      if (chunk.error != null) {
        settle('unknown');
        return;
      }
      if (chunkHasContent(chunk)) settle('content');
    },
  });

  const decoder = new TextDecoder();
  try {
    while (!settled) {
      if (events >= maxEvents) {
        settle('unknown');
        break;
      }
      const remainingMs = maxMs - (now() - startedAt);
      if (remainingMs <= 0) {
        settle('unknown');
        break;
      }
      if (!state.pendingRead) {
        const pending = state.reader.read();
        // The peek may hand this read to the replay stream, so a rejection must not surface as an
        // unhandled one in the meantime.
        void pending.catch(() => {});
        state.pendingRead = pending;
      }
      const read = await raceDeadline(state.pendingRead, remainingMs);
      if (read === 'deadline') {
        // The read stays pending and the replayed stream consumes it, so no byte is lost.
        settle('unknown');
        break;
      }
      state.pendingRead = null;
      if (read.done) {
        // End of stream with no content-bearing delta: an envelope-only answer.
        settle('empty');
        break;
      }
      if (!read.value) continue;
      buffered.push(read.value);
      parser.feed(decoder.decode(read.value, { stream: true }));
    }
  } catch (error) {
    // The caller forwards what was read; the replayed stream repeats the error, so the response
    // pipeline reports it exactly as it would without the peek.
    readError = error;
    settle('unknown');
  }

  return {
    events,
    generationId,
    outcome: settled ? outcome : 'unknown',
    provider,
    response: rebuildResponse(response, state, buffered, readError),
  };
}
