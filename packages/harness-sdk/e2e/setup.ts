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
 * Every live run takes a list of models and runs its checks once per model.
 *
 * The list holds one model, because these runs cost real money: a sweep of
 * eleven is eleven times the bill for a change that touched one code path. The
 * word `full` on the command line asks for all eleven, and nothing else does.
 *
 * `KILO_MODELS` names any list, and wins over `full`.
 */
const one = 'z-ai/glm-5.3-flash';

/**
 * All of them: the ten most used models on OpenRouter this week, from six
 * vendors, and Haiku for the one lab that list leaves out. Every one is cheap.
 * `deepseek-v4-flash-0423` is not served, so the floating alias stands in,
 * `tencent/hy4-preview` is not sold to this team, so a qwen flash takes its
 * place, and `nvidia/nemotron-3-ultra-550b-a55b` is served by nobody — every
 * provider refused it on 2026-09-04 — so a nemotron that is takes its place.
 */
const everyModel = [
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5.6-luna',
  'z-ai/glm-5.3-flash',
  'deepseek/deepseek-v4-flash-0731',
  'qwen/qwen3.8-flash',
  'xiaomi/mimo-v2.5',
  'tencent/hy3',
  'deepseek/deepseek-v4-flash',
  'minimax/minimax-m3',
  'nvidia/nemotron-3.5-lightning',
  'google/gemini-3.7-flash',
] as const;

/* `e2e/all.ts` passes `full` on to each run it spawns as this variable, because
   a run reads its own command line and never sees the sweep's. */
const full = process.argv.includes('full') || process.env['KILO_FULL'] === '1';

/** The models this run works through, in order. Never empty. */
const models: readonly string[] =
  process.env['KILO_MODELS']?.split(',') ?? (full ? everyModel : [one]);

/** For the few checks that are about a shape or a store rather than a model. */
const model = models[0] ?? one;

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

export { baseUrl, cachedSystem, everyShape, full, kilo, model, models, organizationId, token };
