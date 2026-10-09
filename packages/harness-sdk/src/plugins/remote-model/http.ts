import { Effect } from 'effect';
import type { HttpResponse } from '../../core/fetch.js';
import { ModelError, type ModelRequest } from '../../core/model.js';
import type { RetryPolicyService } from '../../core/retry.js';
import type { AbortHandle } from '../gateway/stream.js';
import type { Wire } from '../gateway/wire/wire.js';
import type { RemoteModelConfig } from './index.js';

declare const URL: new (url: string) => {
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly search: string;
  readonly hash: string;
};

/** Provider responses and credential-source failures can contain credentials. */
const safeRemoteError = (error: ModelError): ModelError =>
  new ModelError({
    reason: error.reason,
    ...(error.status === undefined ? {} : { status: error.status }),
    cause: `Remote model ${error.reason} failure`,
  });

const bodyFor = (config: RemoteModelConfig, wire: Wire, request: ModelRequest) =>
  Effect.try({
    try: () => {
      const url = new URL(config.baseUrl);
      if (
        (url.protocol !== 'https:' && url.protocol !== 'http:') ||
        url.username !== '' ||
        url.password !== '' ||
        url.search !== '' ||
        url.hash !== ''
      ) {
        throw new Error('Invalid remote API root');
      }
      if (config.apiKind === 'chat_completions' && request.effort === 'max') {
        throw new Error('Unsupported reasoning effort');
      }
      return JSON.stringify(wire.toBody(request));
    },
    catch: () => new ModelError({ reason: 'unsupported', cause: 'Unsupported remote request' }),
  });

const ownedHeaders = (headers: Readonly<Record<string, string>>): Record<string, string> => {
  const owned: Record<string, string> = { 'content-type': 'application/json' };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith('x-kilo')) {
      throw new Error('Kilo headers are not remote credentials');
    }
    if (lower !== 'content-type') {
      owned[name] = value;
    }
  }
  return owned;
};

const headersFrom = (config: RemoteModelConfig) =>
  Effect.try({
    try: () => config.headers(),
    catch: () => new ModelError({ reason: 'transport', cause: 'Remote header source failed' }),
  }).pipe(
    Effect.flatten,
    Effect.catchAllDefect(() =>
      Effect.fail(new ModelError({ reason: 'transport', cause: 'Remote header source failed' }))
    )
  );

interface Sending {
  readonly path: string;
  readonly body: string;
  readonly handle: AbortHandle | undefined;
}

interface RemoteSending {
  readonly wire: Wire;
  readonly request: ModelRequest;
  readonly handle: AbortHandle | undefined;
}
const send = (
  config: RemoteModelConfig,
  { path, body, handle }: Sending
): Effect.Effect<HttpResponse, ModelError> =>
  headersFrom(config).pipe(
    Effect.flatMap(headers =>
      Effect.tryPromise({
        try: () =>
          config.fetch(`${config.baseUrl.replace(/\/+$/u, '')}${path}`, {
            method: 'POST',
            headers: ownedHeaders(headers),
            body,
            redirect: 'error',
            credentials: 'omit',
            ...(handle === undefined ? {} : { signal: handle.signal }),
          }),
        catch: () => new ModelError({ reason: 'transport', cause: 'Remote request failed' }),
      })
    ),
    Effect.flatMap(response =>
      response.ok && response.status < 300
        ? Effect.succeed(response)
        : Effect.fail(
            new ModelError({
              reason: 'status',
              status: response.status,
              cause: 'Remote request rejected',
            })
          )
    ),
    Effect.mapError(safeRemoteError)
  );

const postRemote = (
  config: RemoteModelConfig,
  retry: RetryPolicyService,
  { wire, request, handle }: RemoteSending
): Effect.Effect<HttpResponse, ModelError> =>
  bodyFor(config, wire, request).pipe(
    Effect.flatMap(body =>
      send(config, { path: wire.path, body, handle }).pipe(Effect.retry(retry.schedule))
    )
  );

export { postRemote, safeRemoteError };
