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
  'compactSession',
  'textOf',
] as const;

const tags = [
  'ModelClient',
  'ModelCatalog',
  'PromptAssembler',
  'SessionStore',
  'TokenSource',
  'RetryPolicy',
  'EntropySource',
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

it('offers the same core from both entry points', () => {
  const missing = Object.keys(core).filter(name => !(name in sdk));

  expect(missing).toStrictEqual([]);
});
