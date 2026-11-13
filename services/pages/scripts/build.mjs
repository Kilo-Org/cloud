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
// Every string it prints from the archive goes through `printable`, so the
// package cannot write a workflow command into the job log.
//
// `--archive FILE` reads a local archive instead of downloading one, for a
// package built by hand. The digest check still applies.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'jsonc-parser';
import {
  OUTPUT,
  SHA256,
  TAG,
  archiveName,
  configProblems,
  packageFileProblems,
  printable,
  readArchive,
} from './package.mjs';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/** The pinned release: a repository, a `pages-<build_id>` tag and the sha256
 * of its archive. The digest is the pin: the tag only says where to look. */
function readSource() {
  const source = JSON.parse(readFileSync(path.join(service, 'source.json'), 'utf8'));
  if (typeof source.repository !== 'string' || !REPOSITORY.test(source.repository))
    throw new Error('source.json repository must be OWNER/NAME');
  if (typeof source.tag !== 'string' || !TAG.test(source.tag))
    throw new Error('source.json tag must be pages-<build_id>');
  if (typeof source.sha256 !== 'string' || !SHA256.test(source.sha256))
    throw new Error('source.json sha256 must be the archive digest, 64 lowercase hex characters');
  return source;
}

// A Pages archive is a few MiB. These bound a stalled or oversized download
// before the digest check can reject it.
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

async function download(source) {
  const url = `https://github.com/${source.repository}/releases/download/${source.tag}/${archiveName(source.tag)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Downloading ${url} failed: ${response.status}`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_ARCHIVE_BYTES)
      throw new Error(`${url} is larger than ${MAX_ARCHIVE_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** A JSON file of the package. A parse error quotes the input, so it is
 * replaced with one that does not. */
function packageJson(directory, name) {
  try {
    return JSON.parse(readFileSync(path.join(directory, name), 'utf8'));
  } catch {
    throw new Error(`The package's ${name} is not JSON`);
  }
}

async function build(localArchive) {
  const source = readSource();
  const committed = parse(readFileSync(path.join(service, 'wrangler.jsonc'), 'utf8'));

  const archive = localArchive ? readFileSync(localArchive) : await download(source);
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== source.sha256)
    throw new Error(`The archive's sha256 is ${digest}, but source.json pins ${source.sha256}`);

  const { files, problems } = readArchive(archive);
  if (problems.length) throw new Error(problems.join('\n'));

  const work = mkdtempSync(path.join(tmpdir(), 'pages-package-'));
  try {
    const staged = path.join(work, 'package');
    for (const [member, bytes] of files) {
      const file = path.join(staged, ...member.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    const layout = packageFileProblems(staged);
    if (layout.length) throw new Error(layout.join('\n'));

    const packaged = packageJson(staged, 'wrangler.json');
    const config = configProblems(packaged, committed);
    if (config.length) throw new Error(config.join('\n'));

    const receipt = packageJson(staged, 'build-receipt.json');
    if (`pages-${receipt.build_id}` !== source.tag)
      throw new Error(
        `The package reports build ${printable(receipt.build_id)}, not the one ${source.tag} names`
      );

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
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
if (!(args.length === 0 || (args.length === 2 && args[0] === '--archive'))) {
  console.error('Usage: build.mjs [--archive FILE]');
  process.exit(2);
}
try {
  console.log(JSON.stringify(await build(args[1]), null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
