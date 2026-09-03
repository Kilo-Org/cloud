import { Effect, Layer } from 'effect';
import type { FetchLike } from './fetch.js';
import { ReplySchema, toBody, toReply } from './kilo-gateway-wire.js';
import { ModelClient, ModelError, type ModelReply, type ModelRequest } from './model.js';

/** Whose credit pays for the call. */
type OrgContext =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly id: string };

interface KiloGatewayConfig {
  /** The gateway origin, such as `https://app.kilocode.ai`. */
  readonly baseUrl: string;
  /** The user token, sent as a bearer token. */
  readonly token: string;
  readonly org: OrgContext;
  /** The caller passes `fetch`, so the package needs no runtime of its own. */
  readonly fetch: FetchLike;
}

const path = '/api/gateway/v1/messages';
const organizationHeader = 'x-kilocode-organizationid';

const headersOf = ({ token, org }: KiloGatewayConfig): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  ...(org.kind === 'organization' ? { [organizationHeader]: org.id } : {}),
});

const send = (
  config: KiloGatewayConfig,
  request: ModelRequest
): Effect.Effect<ModelReply, ModelError> =>
  Effect.tryPromise({
    try: () =>
      config.fetch(`${config.baseUrl.replace(/\/+$/u, '')}${path}`, {
        method: 'POST',
        headers: headersOf(config),
        body: JSON.stringify(toBody(request)),
      }),
    catch: cause => new ModelError({ reason: 'transport', cause }),
  }).pipe(
    Effect.flatMap(response =>
      Effect.tryPromise({
        try: () => response.text(),
        catch: cause => new ModelError({ reason: 'transport', cause }),
      }).pipe(
        Effect.flatMap(text =>
          response.ok
            ? Effect.succeed(text)
            : Effect.fail(
                new ModelError({ reason: 'status', status: response.status, cause: text })
              )
        )
      )
    ),
    Effect.flatMap(text =>
      Effect.try({
        try: () => ReplySchema.parse(JSON.parse(text)),
        catch: cause => new ModelError({ reason: 'body', cause }),
      })
    ),
    Effect.map(toReply)
  );

/** The kilo gateway plugin. It speaks the Anthropic Messages shape. */
const layerKiloGateway = (config: KiloGatewayConfig): Layer.Layer<ModelClient> =>
  Layer.succeed(ModelClient, { send: request => send(config, request) });

export type { KiloGatewayConfig, OrgContext };
export { layerKiloGateway };
