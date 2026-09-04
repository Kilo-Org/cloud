import type { ApiKind, ModelFacts } from '../src/core/catalog.js';
import { layerKilo, type KiloSetup } from '../src/plugins/kilo.js';
import { kiloToken, nodeFetch } from './node-fetch.js';

/**
 * What every live run wires: the package's own composed layer, pointed at the
 * gateway with this machine's kilo token. The token is read once and never
 * printed.
 *
 * These runs are what proves the composed layer is the wiring a caller wants.
 * If one of them has to reach past it for a plugin, it is the wrong shape.
 */
const baseUrl = process.env['KILO_BASE_URL'] ?? 'https://app.kilo.ai';
const organizationId = process.env['KILO_ORG_ID'] ?? '9d278969-5453-4ae3-a51f-a8d2274a7b56';

const token = await kiloToken();

/** Every shape, best first. A model whose provider refuses one falls back. */
const everyShape: readonly ApiKind[] = ['messages', 'responses', 'chat_completions'];

/**
 * The facts go in the fallback rather than in the table, because a live run
 * names its model on the command line and a table would have to know it. Only
 * a run that needs one shape, or a context window, passes anything: the layer
 * already assumes all three.
 */
const kilo = (
  facts: ModelFacts = { apiKinds: everyShape },
  /** For a run that watches the transport, such as the one that cancels. */
  over: Partial<KiloSetup> = {}
): ReturnType<typeof layerKilo> =>
  layerKilo({
    baseUrl,
    org: { kind: 'organization', id: organizationId },
    fetch: nodeFetch,
    token,
    fallback: facts,
    ...over,
  });

export { baseUrl, everyShape, kilo, organizationId, token };
