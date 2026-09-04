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
 *
 * So are the conformance checks and the shipped `fetch`. An entry point is what
 * a consumer bundles, and neither is run in production: `checkStore` and
 * `checkAssembler` belong to a plugin author's test suite, and a caller with a
 * `fetch` adapter of their own should not carry this one.
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
  'said',
  'textOf',
  'questionTool',
  'subagentTool',
] as const;

/** What has an entry point of its own, and must not be reachable from the root. */
const elsewhere = ['checkStore', 'checkAssembler', 'webFetch'] as const;

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

it('keeps what has its own entry point out of the root', () => {
  const leaked = elsewhere.filter(name => name in sdk);

  expect(leaked).toStrictEqual([]);
  /* And they are still reachable. A name in neither place is a name nobody can
     call, which is the failure this whole file exists to catch. */
  expect(['checkStore', 'checkAssembler'].filter(name => !(name in core))).toStrictEqual([]);
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
    'cancelQueued',
    'compactIfFull',
    'definitionsOf',
    'draftOf',
    'enqueue',
    'enqueueMessage',
    'handleOf',
    'locksFor',
    'makeId',
    'makePending',
    'makePart',
    'makeSession',
    'makeTurn',
    'onStore',
    'promptedOf',
    'resolveTools',
    'sinceSummary',
    'takeRun',
    'toolNamed',
    'wiringFor',
  ];
  const leaked = machinery.filter(name => name in sdk);

  expect(leaked).toStrictEqual([]);
  expect(machinery.filter(name => !(name in core))).toStrictEqual([]);
});
