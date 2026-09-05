import { Effect, Layer } from 'effect';
import {
  layerAssembler,
  layerBackoff,
  layerKiloGateway,
  layerWebCrypto,
  ModelCatalog,
  type ModelFacts,
  TokenError,
  TokenSource,
  type TokenSourceService,
} from '@kilocode/harness-sdk';
import { layerExpoStore } from '@kilocode/harness-sdk/plugins/store/expo';
import { type SQLiteDatabase } from 'expo-sqlite';

import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { API_BASE_URL } from '@/lib/config';
import { chatFetch } from './fetch';

/**
 * The plugins the chat runs on.
 *
 * `layerKilo` is the wiring most callers want and it builds its own catalog
 * from a fixed table. This app's table is not fixed: the models come from the
 * gateway while the app is running, and a session opened before they arrived
 * would never learn its own context window and so would never compact. So the
 * layers are composed by hand, over a catalog that reads what the app knows now.
 */

/**
 * Every relayed model speaks all three gateway shapes, and the best one it
 * really speaks is picked from this list. A model nobody has told us about gets
 * this and no window, which means it never compacts — an honest answer, and one
 * the next catalog read fixes.
 */
const EVERY_SHAPE: ModelFacts = { apiKinds: ['messages', 'responses', 'chat_completions'] };

/** What the app has been told about each model, replaced as the catalog loads. */
let known: ReadonlyMap<string, ModelFacts> = new Map();

/**
 * Takes the gateway's model list as the facts a session needs.
 *
 * Only the window comes from it. The shapes do not: the gateway relays a model
 * from whichever provider serves it and says nothing about which shapes that
 * provider speaks, so the assumption above stands for every model.
 */
export function rememberModelFacts(
  models: readonly { readonly id: string; readonly context_length?: number | null }[]
): void {
  known = new Map(
    models.map(model => [
      model.id,
      model.context_length === null || model.context_length === undefined
        ? EVERY_SHAPE
        : { ...EVERY_SHAPE, contextWindow: model.context_length },
    ])
  );
}

/** One catalog instance, shared by the session and the gateway as it must be. */
const layerCatalog = Layer.succeed(ModelCatalog, {
  facts: (model: string) => Effect.succeed(known.get(model) ?? EVERY_SHAPE),
});

/**
 * The signed-in credential, read for every call.
 *
 * The app's token expires and is refreshed under this, and a chat outlives
 * both. Reading it per call is why: a source that held a string would start
 * failing with 401 while still believing in it.
 */
const layerToken = Layer.succeed(TokenSource, {
  get: () =>
    Effect.tryPromise({
      try: async () => {
        const token = await getAuthTokenForRequest();
        if (token === null) {
          throw new Error('the app is signed out');
        }
        return token;
      },
      catch: cause => new TokenError({ cause }),
    }),
} satisfies TokenSourceService);

/** Whose credit pays for the chat. */
export type ChatOrg =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly id: string };

export function chatLayers(database: SQLiteDatabase, org: ChatOrg) {
  const gateway = layerKiloGateway({ baseUrl: API_BASE_URL, org, fetch: chatFetch }).pipe(
    Layer.provide(Layer.mergeAll(layerCatalog, layerToken, layerBackoff(2)))
  );
  return Layer.mergeAll(
    layerAssembler,
    layerWebCrypto,
    layerCatalog,
    gateway,
    layerExpoStore(database)
  );
}
