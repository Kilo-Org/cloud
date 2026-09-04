import type { ApiKind, ModelFacts } from '../src/core/catalog.js';
import { layerKilo, type KiloSetup } from '../src/plugins/kilo.js';
import { webFetch } from '../src/plugins/fetch/web.js';
import { kiloToken } from './token.js';

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
 * The model a run uses when it does not care which. Cheap, quick, and it speaks
 * every shape. `KILO_MODEL` points a run at another one.
 *
 * Eleven runs wrote this line each, so eleven had to be edited to try a
 * different model, and one of them was always missed.
 */
const model = process.env['KILO_MODEL'] ?? 'anthropic/claude-haiku-4.5';

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
    fetch: webFetch,
    token,
    fallback: facts,
    ...over,
  });

/**
 * A system prompt long enough to be cached, and rules strict enough that an
 * answer is one word.
 *
 * The cached prefix must clear the model's minimum, which is 4096 tokens on
 * Haiku 4.5. A short system prompt caches nothing at all, and a run that
 * measured the cache would read as a failure of the package rather than of the
 * prompt it was given.
 */
const rule = (index: number) =>
  `Rule ${String(index)}: when the user asks for a word, answer with that one word and nothing else. ` +
  'Do not explain. Do not add punctuation beyond the word itself. Do not greet the user. ' +
  'Do not restate the question. Keep the answer to a single lowercase word.';

const cachedSystem = [
  'You are a test harness. Follow every rule below.',
  ...Array.from({ length: 200 }, (_, index) => rule(index)),
].join('\n');

export { baseUrl, cachedSystem, everyShape, kilo, model, organizationId, token };
