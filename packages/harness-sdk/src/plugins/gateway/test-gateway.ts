import { Layer } from 'effect';
import type { ApiKind } from '../../core/catalog.js';
import type { FetchLike } from '../../core/fetch.js';
import type { OrgContext } from './http.js';
import { layerKiloGateway } from './index.js';
import type { ModelClient } from '../../core/model.js';
import { layerBackoff, layerNoRetry } from '../retry/backoff.js';
import { layerStaticToken } from '../token/static.js';
import { layerTableCatalog } from '../catalog/table.js';

/**
 * The gateway with every plugin it needs, wired for a test: the catalog answers
 * `kinds` for any model, the token never changes, and nothing is retried unless
 * the test asks for it.
 */
const testGateway = (options: {
  readonly fetch: FetchLike;
  readonly kinds?: readonly ApiKind[];
  readonly retries?: number;
  readonly org?: OrgContext;
  readonly baseUrl?: string;
}): Layer.Layer<ModelClient> =>
  layerKiloGateway({
    baseUrl: options.baseUrl ?? 'https://app.kilocode.ai',
    org: options.org ?? { kind: 'personal' },
    fetch: options.fetch,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerTableCatalog({}, { apiKinds: options.kinds ?? ['messages'] }),
        layerStaticToken('tok'),
        options.retries === undefined ? layerNoRetry : layerBackoff(options.retries)
      )
    )
  );

export { testGateway };
