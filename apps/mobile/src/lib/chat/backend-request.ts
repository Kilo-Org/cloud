import { type FetchLike, type HttpRequest, ModelError } from '@kilocode/harness-sdk';
import { remoteModelClient } from '@kilocode/harness-sdk/plugins/remote-model';
import { Effect, Schedule, Stream } from 'effect';
import { fetch as nativeFetch } from 'expo/fetch';
import { z } from 'zod';

import { remoteChatFetch } from './fetch';
import { assertBackendTransport } from './backend-transport';
import {
  type BackendConnection,
  BackendInputError,
  type BackendModel,
  BackendRequestError,
  type BackendRequestProblem,
  type ChatBackendDraft,
  validateBackendConnection,
  validateChatBackendDraft,
} from './backend-store';

export type BackendConnectionCheckOptions = { signal: AbortSignal; transport?: FetchLike };
/** Custom headers override defaults case-insensitively; never merge Kilo auth. */
export function backendHeaders(
  profile: Pick<ChatBackendDraft, 'apiKind' | 'apiKey' | 'headers'>
): HttpRequest['headers'] {
  const headers: Record<string, string> = {};
  if (profile.apiKind === 'messages') {
    headers['anthropic-version'] = '2023-06-01';
    if (profile.apiKey) {
      headers['x-api-key'] = profile.apiKey;
    }
  } else if (profile.apiKey) {
    headers.authorization = `Bearer ${profile.apiKey}`;
  }
  for (const [name, value] of Object.entries(profile.headers)) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

const modelListSchema = z
  .object({
    data: z.array(
      z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1).optional() }).strip()
    ),
  })
  .strip();

/** The 401 a credential refusal answers with. */
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
/** The 404 or 405 an absent endpoint or model answers with. */
const NOT_FOUND = 404;
const METHOD_NOT_ALLOWED = 405;
const TOO_MANY_REQUESTS = 429;
/** The first status that says the endpoint itself failed, not the request. */
const SERVER_ERROR = 500;

export type BackendDiscoveryFetch = (
  url: string,
  request: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
    redirect: 'error';
    credentials: 'omit';
  }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** The model call rejects with this plain `Error` when the external signal aborts: only interrupts. */
const callerCancelled = (error: unknown): boolean =>
  error instanceof Error && error.message === 'All fibers interrupted without error';

/** The only failure `Effect.timeout` raises, observed on the installed `effect`. */
const timeoutExpired = (error: unknown): boolean =>
  error instanceof Error && '_tag' in error && error._tag === 'TimeoutError';

/**
 * The problem a status names. A status the classes miss (or one the transport
 * never reported) is a reply the checks cannot classify, so it reads as an
 * unusable response body.
 */
function problemOfStatus(status: number | undefined): BackendRequestProblem {
  if (status === UNAUTHORIZED || status === FORBIDDEN) {
    return 'unauthorized';
  }
  if (status === NOT_FOUND || status === METHOD_NOT_ALLOWED) {
    return 'notFound';
  }
  if (status === TOO_MANY_REQUESTS) {
    return 'rateLimited';
  }
  if (status !== undefined && status >= SERVER_ERROR) {
    return 'unavailable';
  }
  return 'invalidResponse';
}

/**
 * The problem a `ModelError` names, read by its reason alone. `stream` is the
 * one that arrives after the answer started, so the request was not the
 * problem: the answer stopped part way. A status failure whose transport never
 * reported the number is a malformed reply.
 */
function problemOfModelError(error: ModelError): BackendRequestProblem {
  if (error.reason === 'stream') {
    return 'incomplete';
  }
  if (error.reason === 'status') {
    return problemOfStatus(error.status);
  }
  return 'unreachable';
}

/** Discovery is optional; callers retain their manual models on any failure. */
export async function discoverBackendModels(
  input: BackendConnection,
  signal: AbortSignal,
  transport: BackendDiscoveryFetch = nativeFetch
): Promise<BackendModel[]> {
  const profile = validateBackendConnection(input);
  const baseUrl = profile.baseUrl;
  assertBackendTransport(baseUrl);
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };
  // The cancel and deadline states live in holders: a boolean a closure only
  // ever sets reads as its narrowed literal to the type checker, which then
  // calls every later check of it dead. A mutable holder keeps the checks live.
  const cancelState = { aborted: false };
  const cancel = () => {
    cancelState.aborted = true;
    abort();
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) {
    cancel();
    // Nothing is sent, so nothing but the caller's cancel can classify here.
    signal.removeEventListener('abort', cancel);
    throw new BackendRequestError('cancelled');
  }
  const deadlineState = { reached: false };
  const deadline = setTimeout(() => {
    deadlineState.reached = true;
    abort();
  }, 15_000);
  try {
    const response = await transport(`${baseUrl}/models`, {
      method: 'GET',
      headers: backendHeaders(profile),
      signal: controller.signal,
      redirect: 'error',
      credentials: 'omit',
    });
    if (!response.ok) {
      if (cancelState.aborted) {
        throw new BackendRequestError('cancelled');
      }
      throw new BackendRequestError(problemOfStatus(response.status));
    }
    const data: unknown = JSON.parse(await response.text());
    const parsed = modelListSchema.parse(data);
    const seen = new Set<string>();
    const models: BackendModel[] = [];
    for (const model of parsed.data) {
      if (!seen.has(model.id)) {
        models.push({
          id: model.id,
          name: model.name ?? model.id,
          tools: false,
          images: false,
          reasoning: false,
        });
        seen.add(model.id);
      }
    }
    if (models.length === 0) {
      throw new BackendRequestError('noModels');
    }
    return models;
  } catch (error) {
    if (error instanceof BackendRequestError) {
      throw error;
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      // Unparseable or schema-invalid: the endpoint answered, badly.
      throw new BackendRequestError('invalidResponse');
    }
    if (cancelState.aborted) {
      throw new BackendRequestError('cancelled');
    }
    if (deadlineState.reached) {
      // The transport returned or rejected after the deadline aborted it.
      throw new BackendRequestError('timedOut');
    }
    // Every other transport rejection: network, DNS, TLS, or a request the
    // transport cancelled on its own. Provider text can echo authorization
    // headers or API keys, so only the problem class speaks.
    throw new BackendRequestError('unreachable');
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', cancel);
  }
}

/** This is an explicitly requested, billable inference, not a /models ping. */
export async function checkBackendConnection(
  input: ChatBackendDraft,
  modelId: string,
  { signal, transport = remoteChatFetch }: BackendConnectionCheckOptions
): Promise<void> {
  const profile = validateChatBackendDraft(input);
  assertBackendTransport(profile.baseUrl);
  if (!profile.models.some(model => model.id === modelId)) {
    throw new BackendInputError('invalidInput');
  }
  const client = remoteModelClient(
    {
      baseUrl: profile.baseUrl,
      apiKind: profile.apiKind,
      completionTokenField: profile.completionTokenField,
      fetch: transport,
      headers: () => Effect.succeed(backendHeaders(profile)),
    },
    { schedule: Schedule.recurs(0) }
  );
  // The fold's held state survives a stream failure that drops the model
  // error's own cause mapping, so received-but-unfinished still reads as
  // incomplete; the mutable holder keeps one state alive across that failure.
  const held = { receivedText: false, completed: false };
  // A holder for the same reason as discovery's: repeated truthiness reads of
  // `signal.aborted` narrow to false and the checker calls the later ones dead.
  const cancelState = { aborted: false };
  signal.addEventListener(
    'abort',
    () => {
      cancelState.aborted = true;
    },
    { once: true }
  );
  if (signal.aborted) {
    cancelState.aborted = true;
  }
  try {
    const result = await Effect.runPromise(
      Stream.runFold(
        client.stream({
          model: modelId,
          maxTokens: 16,
          prompt: {
            system: [],
            messages: [
              { role: 'user', cache: false, parts: [{ kind: 'text', text: 'Reply OK.' }] },
            ],
          },
        }),
        () => held,
        (current, event) => {
          if (event.kind === 'delta' && event.text !== '') {
            current.receivedText = true;
          }
          if (event.kind === 'done') {
            current.completed = event.stop === 'end' || event.stop === 'maxTokens';
          }
          return current;
        }
      ).pipe(Effect.timeout('15 seconds')),
      { signal }
    );
    if (!result.receivedText || !result.completed) {
      throw new BackendRequestError('incomplete');
    }
  } catch (error) {
    if (error instanceof BackendRequestError) {
      throw error;
    }
    if (cancelState.aborted) {
      // A timeout that expired before the abort is the deadline's win; the
      // abort itself reads as `All fibers interrupted without error`.
      throw timeoutExpired(error)
        ? new BackendRequestError('timedOut')
        : new BackendRequestError('cancelled');
    }
    if (timeoutExpired(error) || callerCancelled(error)) {
      throw new BackendRequestError(timeoutExpired(error) ? 'timedOut' : 'cancelled');
    }
    if (held.receivedText && !held.completed) {
      throw new BackendRequestError('incomplete');
    }
    // The routed model client re-reports a status refusal through its cause.
    for (const failure of [error, error instanceof ModelError ? error.cause : undefined]) {
      if (failure instanceof ModelError) {
        throw new BackendRequestError(problemOfModelError(failure));
      }
    }
    // A transport, body, or unsupported failure, or one the SDK could not name.
    // Provider text can echo authorization headers or API keys, so only the
    // problem class speaks.
    throw new BackendRequestError('unreachable');
  }
}
