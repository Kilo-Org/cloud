#!/usr/bin/env node
// Fill `dist/` with the released Pages package that `source.json` pins.
//
// nteract builds and publishes Pages as a release asset; this script runs no
// code from that repository. It downloads the pinned archive, checks it
// against the pinned sha256, reads it as untrusted input (regular files in the
// package layout only), and checks the package's structural Wrangler fields
// against `wrangler.jsonc` before anything is copied. It runs as `predeploy`,
// so `deploy-workers.yml` fills `dist/` right before `wrangler deploy`.
//
// `dist/` gets `worker/`, `public/` and `build-receipt.json`. The package's
// `output/` is the output shell, which `services/pages-output` builds from the
// same pin and deploys as its own Worker; none of it reaches this Worker.
//
// Every string it prints from the archive goes through `printable`, so the
// package cannot write a workflow command into the job log.
//
// `--archive FILE` reads a local archive instead of downloading one, for a
// package built by hand. The digest check still applies.
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import { OUTPUT, configProblems } from './package.mjs';
import { packageJson, runBuild, withPinnedPackage } from './pinned.mjs';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function build(localArchive) {
  const committed = parse(readFileSync(path.join(service, 'wrangler.jsonc'), 'utf8'));

  return withPinnedPackage(localArchive, ({ staged, source, receipt }) => {
    const packaged = packageJson(staged, 'wrangler.json');
    const config = configProblems(packaged, committed);
    if (config.length) throw new Error(config.join('\n'));

    const output = path.join(service, OUTPUT);
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output);
    for (const entry of ['worker', 'public', 'build-receipt.json'])
      cpSync(path.join(staged, entry), path.join(output, entry), { recursive: true });

    return {
      worker: committed.name,
      repository: source.repository,
      tag: source.tag,
      build_id: receipt.build_id,
      source_commit: receipt.source_sha,
      document_formats: receipt.document_formats,
    };
  });
}

await runBuild('build.mjs', build);
