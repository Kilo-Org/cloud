import { Effect, Layer, Stream } from 'effect';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelEvent } from '../src/core/model.js';
import type { SessionHandle } from '../src/core/handle.js';
import type { SessionOptions } from '../src/core/wiring.js';
import type { KiloSetup } from '../src/plugins/kilo.js';

/**
 * Fails when the built package does not import, or does not run.
 *
 * Every test in this repository runs against `src/`. A consumer runs against
 * `dist/`, reached through the `exports` map, and the two are not the same
 * code: typia's validators are compiled into the build, the imports are
 * rewritten, and a subpath that resolves to nothing fails at a consumer's
 * first import with nothing here to have caught it.
 *
 * So this asks each entry point for one name it promises, and then asks one
 * session a question through the built gateway against a `fetch` that answers
 * from memory. That last part is the point: it runs a compiled validator over
 * a stream event, which no other check does.
 *
 * It reads `dist/`, so `pnpm build` runs first.
 */

const root = join(import.meta.dirname, '..');

interface Entry {
  readonly subpath: string;
  readonly promises: readonly string[];
}

/** Every `exports` subpath, and a name a caller reaches it for. */
const entries: readonly Entry[] = [
  { subpath: '.', promises: ['layerKilo', 'openSession', 'ModelClient', 'SessionBusyError'] },
  { subpath: './core', promises: ['ModelClient', 'SessionStore', 'wiringFor', 'makeId'] },
  { subpath: './plugins/gateway', promises: ['layerKiloGateway'] },
  { subpath: './plugins/prompt', promises: ['assemble', 'layerAssembler'] },
  { subpath: './plugins/store/node', promises: ['layerNodeStore'] },
  { subpath: './plugins/store/expo', promises: ['layerExpoStore'] },
];

const map = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Readonly<Record<string, string>>;
};

const broken: string[] = [];

const fileOf = (subpath: string): string | undefined => {
  const target = map.exports[subpath];
  return target === undefined ? undefined : join(root, target);
};

const loaded: Record<string, Record<string, unknown>> = {};

for (const entry of entries) {
  const file = fileOf(entry.subpath);
  if (file === undefined) {
    broken.push(`${entry.subpath} is not in the exports map`);
    continue;
  }
  try {
    const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    loaded[entry.subpath] = module;
    const missing = entry.promises.filter(name => module[name] === undefined);
    if (missing.length > 0) {
      broken.push(`${entry.subpath} exports no ${missing.join(', no ')}`);
    }
  } catch (cause) {
    broken.push(`${entry.subpath} does not import: ${String(cause)}`);
  }
}

/** One streamed answer, so a compiled validator has something to read. */
const frames = [
  { type: 'message_start', message: { usage: { input_tokens: 5 } } },
  { type: 'content_block_delta', delta: { text: 'built' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
]
  .map(frame => `data: ${JSON.stringify(frame)}\n\n`)
  .join('');

const answering = () =>
  Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(''),
    stream: async function* stream() {
      yield frames;
    },
  });

const rootModule = loaded['.'];
if (rootModule === undefined) {
  process.stdout.write(`the built package does not import:\n${broken.join('\n')}\n`);
  process.exit(1);
}

/* The build is supposed to match the types its own source declares, so those
   are what the values coming out of `dist/` are read as. The imports are types
   only, and nothing of `src/` is loaded. */
const layerKilo = rootModule['layerKilo'] as (setup: KiloSetup) => Layer.Layer<never>;
const openSession = rootModule['openSession'] as (
  options: SessionOptions
) => Effect.Effect<SessionHandle, never, never>;

try {
  const said = await Effect.runPromise(
    Effect.scoped(
      Effect.provide(
        Effect.flatMap(openSession({ system: 'sys', model: 'm', maxTokens: 8 }), session =>
          Stream.runFold(session.ask('hi'), '', (held: string, event: ModelEvent) =>
            event.kind === 'delta' ? held + event.text : held
          )
        ),
        layerKilo({
          baseUrl: 'https://gateway.test',
          org: { kind: 'personal' },
          fetch: answering,
          token: 'tok',
          fallback: { apiKinds: ['messages'] },
        })
      )
    )
  );
  if (said !== 'built') {
    broken.push(`a session built from dist/ answered ${JSON.stringify(said)}, not "built"`);
  }
} catch (cause) {
  broken.push(`a session built from dist/ could not answer: ${String(cause)}`);
}

if (broken.length === 0) {
  process.stdout.write(
    `the built package imports and answers, from all ${String(entries.length)} entry points\n`
  );
  process.exit(0);
}

process.stdout.write(
  `the built package is not what it promises. Check the exports map and the build:\n${broken.join('\n')}\n`
);
process.exit(1);
