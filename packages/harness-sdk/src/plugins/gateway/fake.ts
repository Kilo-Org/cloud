import type { FetchLike, HttpRequest } from '../../core/fetch.js';
import { assemble } from '../prompt/default.js';
import type { ModelRequest } from '../../core/model.js';
import type { Turn } from '../../core/turn.js';

interface Call {
  readonly url: string;
  readonly request: HttpRequest;
}

interface Reply {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
  readonly chunks?: readonly string[];
}

const notFound: Reply = { ok: false, status: 404, body: 'no reply configured' };

const turn = (role: Turn['role'], content: string): Turn => ({
  id: `trn_${content}`,
  sessionId: 'ses_1',
  role,
  parts: [{ id: `prt_${content}`, kind: 'text', body: content }],
});

/** A request over a two turn session, used by every gateway test. */
const sampleRequest = (): ModelRequest => ({
  prompt: assemble({
    system: 'sys',
    turns: [turn('user', 'a'), turn('assistant', 'b')],
  }),
  model: 'claude-opus-5',
  maxTokens: 1024,
  cacheKey: 'ses_1',
});

/** One server-sent event per frame, the way every shape sends them. */
const sse = (...events: readonly unknown[]): readonly string[] =>
  events.map(event => `data: ${JSON.stringify(event)}\n\n`);

const toAsync = async function* toAsync(chunks: readonly string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
};

/** Answers each call with the next reply and records what was sent. */
const fakeFetch = (replies: readonly Reply[]): { calls: Call[]; fetch: FetchLike } => {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, request) => {
    calls.push({ url, request });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] ?? notFound;
    return Promise.resolve({
      ok: reply.ok,
      status: reply.status,
      text: () => Promise.resolve(reply.body),
      ...(reply.chunks === undefined ? {} : { stream: () => toAsync(reply.chunks ?? []) }),
    });
  };
  return { calls, fetch };
};

export type { Reply };
export { fakeFetch, sampleRequest, sse, toAsync };
