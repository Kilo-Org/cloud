#!/usr/bin/env node
// Fill `dist/` with the output shell from the Pages release that
// `../pages/source.json` pins.
//
// There is one pin for both Workers. This script reads it, downloads and
// checks the archive with the same code as the Pages build
// (`../pages/scripts/pinned.mjs`), compares the package's `output/wrangler.json`
// with `wrangler.jsonc`, checks `output/worker.js` against the sha256 the build
// receipt certifies, and writes that one module to `dist/worker.js`. It runs
// as `predeploy`, so `deploy-workers.yml` fills `dist/` right before
// `wrangler deploy`.
//
// Every string it prints from the archive goes through `printable` or
// `JSON.stringify`, so the package cannot write a workflow command into the
// job log.
//
// `--archive FILE` reads a local archive instead of downloading one, for a
// package built by hand. The digest check still applies.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { runBuild, withPinnedPackage } from '../../pages/scripts/pinned.mjs';
import { buildShell } from './shell.mjs';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function build(localArchive) {
  const committed = parse(readFileSync(path.join(service, 'wrangler.jsonc'), 'utf8'));
  return withPinnedPackage(localArchive, opened => buildShell(opened, committed, service));
}

await runBuild('build.mjs', build);
