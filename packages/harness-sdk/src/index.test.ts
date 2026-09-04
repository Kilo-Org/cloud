import { expect, it } from 'vitest';
import * as sdk from './index.js';
import * as core from './core/index.js';

/**
 * What a consumer can reach.
 *
 * A module left out of a barrel is invisible from outside the package and
 * nothing else notices: every test here imports by path, so the whole package
 * passes while a consumer cannot call half of it. That has happened twice —
 * compaction and the composed layer were both unreachable — so the surface the
 * README documents is asserted rather than assumed.
 *
 * The two store plugins are deliberately absent. Each names a platform, so
 * exporting them from the root would pull `node:sqlite` or `expo-sqlite` into
 * every bundle. They have subpaths of their own.
 */

/** Every layer the README's plugin table names. */
const layers = [
  'layerKilo',
  'layerKiloGateway',
  'layerAssembler',
  'layerTableCatalog',
  'layerStaticToken',
  'layerBackoff',
  'layerNoRetry',
  'layerWebCrypto',
  'layerSeededEntropy',
] as const;

/** What a caller opens, continues, or reads a session with. */
const functions = [
  'openSession',
  'continueSession',
  'cloneSession',
  'hitRatio',
  'textOf',
  'questionTool',
] as const;

const tags = [
  'ModelClient',
  'ModelCatalog',
  'PromptAssembler',
  'SessionStore',
  'TokenSource',
  'RetryPolicy',
  'EntropySource',
  'ToolRegistry',
] as const;

it('exports every layer a consumer wires', () => {
  const missing = layers.filter(name => !(name in sdk));

  expect(missing).toStrictEqual([]);
});

it('exports every call a consumer makes', () => {
  const missing = [...functions, ...tags].filter(name => !(name in sdk));

  expect(missing).toStrictEqual([]);
});

it('keeps the core entry point free of plugins', () => {
  const plugins = layers.filter(name => name in core);

  expect(plugins).toStrictEqual([]);
});

it('keeps the machinery of a session out of the root', () => {
  /* The root is what a consumer calls. These run a session from the inside and
     are reached through `/core`, so a caller reading `history` is not offered
     them. Deleting a name from this list is fine; adding one to the root by
     accident is what the test is for. */
  const machinery = [
    'appendTurn',
    'compactIfFull',
    'definitionsOf',
    'draftOf',
    'handleOf',
    'locksFor',
    'makeId',
    'makePart',
    'makeSession',
    'makeTurn',
    'onStore',
    'promptedOf',
    'resolveTools',
    'sinceSummary',
    'toolNamed',
    'wiringFor',
  ];
  const leaked = machinery.filter(name => name in sdk);

  expect(leaked).toStrictEqual([]);
  expect(machinery.filter(name => !(name in core))).toStrictEqual([]);
});
