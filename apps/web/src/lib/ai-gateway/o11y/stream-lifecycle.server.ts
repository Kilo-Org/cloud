import { createHash } from 'node:crypto';

const MAX_EVENT_TEXT = 64 * 1024;
const NORMAL_SAMPLE_RATE = 0.001;
// Cancellation and other inconclusive pairs are sampled at 0.01% to provide controls without noise.
const INCONCLUSIVE_SAMPLE_RATE = 0.0001;

export const STREAM_ATTEMPT_HEADER = 'x-kilo-attempt-id';

type Disposition = 'eof' | 'error' | 'cancel';
type Side = 'provider' | 'final';

export type StreamOutcome = {
  bytes: number;
  chunks: number;
  sha256: string;
  events: number;
  malformed_events: number;
  last_event_type: string | null;
  terminal_event: boolean;
  unterminated_final_block: boolean;
  disposition: Disposition;
};

type Context = {
  attempt_id: string;
  provider_id: string;
  api_kind: string;
};

type Classification =
  | 'control'
  | 'divergence'
  | 'error'
  | 'final_cancelled'
  | 'source_incomplete'
  | 'inconclusive';

type TrackerOptions = {
  random?: () => number;
  log?: (message: string, data: Record<string, unknown>) => void;
};

export function createStreamLifecycleTracker(context: Context, options: TrackerOptions = {}) {
  const outcomes: Partial<Record<Side, StreamOutcome>> = {};
  let paired = false;

  return {
    observe(side: Side, outcome: StreamOutcome) {
      outcomes[side] = outcome;
      const provider = outcomes.provider;
      const final = outcomes.final;
      if (!provider || !final || paired) return;
      paired = true;

      const classification = classify(provider, final);
      const rate =
        classification === 'control'
          ? NORMAL_SAMPLE_RATE
          : classification === 'inconclusive'
            ? INCONCLUSIVE_SAMPLE_RATE
            : 1;
      if (rate < 1 && (options.random ?? Math.random)() >= rate) return;

      const message =
        classification === 'control'
          ? 'AI stream lifecycle control'
          : classification === 'inconclusive'
            ? 'AI stream lifecycle inconclusive'
            : 'AI stream lifecycle anomaly';
      const data = {
        ...context,
        classification,
        vercel_deployment: process.env.VERCEL_DEPLOYMENT_ID ?? null,
        vercel_region: process.env.VERCEL_REGION ?? process.env.VERCEL_FUNCTION_REGION ?? null,
        provider,
        final,
      };
      if (options.log) {
        options.log(message, data);
        return;
      }

      const record = JSON.stringify({ event: 'ai_stream_lifecycle', ...data });
      if (classification === 'control' || classification === 'inconclusive') {
        console.log(record);
        return;
      }
      console.warn(record);
    },
  };
}

export function observeEventStream(
  source: ReadableStream<Uint8Array>,
  done: (outcome: StreamOutcome) => void,
  owner?: object
): ReadableStream<Uint8Array> {
  const hash = createHash('sha256');
  const scanner = createScanner();
  let retained = owner;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let bytes = 0;
  let chunks = 0;
  let settled = false;
  let cancelled = false;

  const releaseOwner = () => {
    if (retained === undefined) return;
    retained = undefined;
  };
  const report = (error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'ai_stream_lifecycle_observer_failure',
        error_type: error instanceof Error ? error.name : typeof error,
      })
    );
  };
  const settle = (disposition: Disposition) => {
    if (settled) return;
    settled = true;
    try {
      const ending = scanner.finish();
      done({
        bytes,
        chunks,
        sha256: hash.digest('hex'),
        ...ending,
        disposition,
      });
    } catch (error) {
      report(error);
    } finally {
      releaseOwner();
    }
  };
  const release = () => {
    const active = reader;
    reader = null;
    active?.releaseLock();
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reader ??= source.getReader();
        const active = reader;
        try {
          const result = await active.read();
          if (cancelled) return;
          if (result.done) {
            settle('eof');
            controller.close();
            release();
            return;
          }
          bytes += result.value.byteLength;
          chunks += 1;
          hash.update(result.value);
          scanner.push(result.value);
          controller.enqueue(result.value);
        } catch (error) {
          if (cancelled) return;
          settle('error');
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        cancelled = true;
        settle('cancel');
        try {
          if (reader) await reader.cancel(reason);
          else await source.cancel(reason);
        } finally {
          release();
        }
      },
    },
    { highWaterMark: 0 }
  );
}

function classify(provider: StreamOutcome, final: StreamOutcome): Classification {
  if (provider.disposition === 'error' || final.disposition === 'error') return 'error';
  const providerClean = isClean(provider);
  if (provider.disposition === 'eof' && !providerClean) return 'source_incomplete';
  if (providerClean && final.disposition === 'cancel') return 'final_cancelled';

  const finalClean = isClean(final);
  if (providerClean && final.disposition === 'eof') {
    if (!finalClean || provider.sha256 !== final.sha256 || provider.bytes !== final.bytes) {
      return 'divergence';
    }
    return 'control';
  }
  return 'inconclusive';
}

function isClean(outcome: StreamOutcome) {
  return (
    outcome.disposition === 'eof' &&
    outcome.terminal_event &&
    outcome.malformed_events === 0 &&
    !outcome.unterminated_final_block
  );
}

export function isEventStreamContentType(contentType: string | null) {
  if (!contentType) return false;
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}

export function shouldObserveEventStream(input: {
  provider_id: string;
  status: number;
  has_body: boolean;
  content_type: string | null;
}) {
  return (
    input.provider_id === 'custom' &&
    input.status >= 200 &&
    input.status < 300 &&
    input.has_body &&
    isEventStreamContentType(input.content_type)
  );
}

function createScanner() {
  const decoder = new TextDecoder();
  let text = '';
  let overflow = false;
  let events = 0;
  let malformed = 0;
  let last: string | null = null;
  let terminal = false;

  const consume = (block: string, truncated: boolean) => {
    if (truncated || block.length > MAX_EVENT_TEXT) {
      events += 1;
      malformed += 1;
      return;
    }
    const lines = block.split(/\r\n|\n|\r/);
    const named = lines
      .find(line => line.startsWith('event:'))
      ?.slice(6)
      .trim();
    const data = lines
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');

    if (!named && !data) return;
    events += 1;
    if (named) last = named;
    if (data.trim() === '[DONE]') {
      last = named || '[DONE]';
      terminal = true;
      return;
    }
    if (!data) return;

    try {
      const value = JSON.parse(data) as Record<string, unknown>;
      if (typeof value.type === 'string') last = value.type;
      const choices = Array.isArray(value.choices) ? value.choices : [];
      const finished = choices.some(choice => {
        if (!choice || typeof choice !== 'object') return false;
        return (choice as Record<string, unknown>).finish_reason != null;
      });
      terminal ||=
        value.type === 'response.completed' ||
        value.type === 'response.incomplete' ||
        value.type === 'response.failed' ||
        value.type === 'message_stop' ||
        finished;
    } catch {
      malformed += 1;
    }
  };

  const scan = () => {
    while (true) {
      const match = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(text);
      if (!match) break;
      consume(text.slice(0, match.index), overflow);
      text = text.slice(match.index + match[0].length);
      overflow = false;
    }
    if (text.length <= MAX_EVENT_TEXT) return;

    // Preserve only enough trailing text to detect a delimiter split across chunks.
    text = text.slice(-3);
    overflow = true;
  };

  return {
    push(chunk: Uint8Array) {
      text += decoder.decode(chunk, { stream: true });
      scan();
    },
    finish() {
      text += decoder.decode();
      scan();
      return {
        events,
        malformed_events: malformed,
        last_event_type: last,
        terminal_event: terminal,
        unterminated_final_block: overflow || text.length > 0,
      };
    },
  };
}
