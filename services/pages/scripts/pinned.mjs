// The Pages release that `source.json` pins, downloaded and checked once for
// every Worker built from it.
//
// Two folders deploy from this one pin: this one deploys the package's Worker
// and browser assets, and `services/pages-output` deploys its output shell
// from `output/`. Both builds call `withPinnedPackage`, so a release reaches
// either Worker only after the same digest, archive and layout checks, and a
// pull request that moves the pin moves both.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHA256,
  TAG,
  archiveName,
  packageFileProblems,
  printable,
  readArchive,
} from './package.mjs';

/** The pin both Workers build from. */
export const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../source.json');
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The pinned release: a repository, a `pages-<build_id>` tag and the sha256
 * of its archive. The digest is the pin: the tag only says where to look. */
export function readSource() {
  const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
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
export function packageJson(directory, name) {
  try {
    return JSON.parse(readFileSync(path.join(directory, ...name.split('/')), 'utf8'));
  } catch {
    throw new Error(`The package's ${name} is not JSON`);
  }
}

/** Runs `use({ staged, source, receipt })` on `archive`, extracted to a
 * temporary directory that is removed when `use` settles. Before `use` runs,
 * the archive matches `source.sha256`, every member passes `readArchive`, the
 * extracted layout passes `packageFileProblems`, and the build receipt names
 * the build that `source.tag` names. */
export async function openPackage(archive, source, use) {
  const digest = sha256(archive);
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

    const receipt = packageJson(staged, 'build-receipt.json');
    if (`pages-${receipt.build_id}` !== source.tag)
      throw new Error(
        `The package reports build ${printable(receipt.build_id)}, not the one ${source.tag} names`
      );
    return await use({ staged, source, receipt });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** `openPackage` on the release `source.json` pins. `localArchive` reads a
 * file instead of downloading, for a package built by hand; the digest check
 * still applies. */
export async function withPinnedPackage(localArchive, use) {
  const source = readSource();
  const archive = localArchive ? readFileSync(localArchive) : await download(source);
  return openPackage(archive, source, use);
}

/** The command line both builds take: no arguments, or `--archive FILE`.
 * Prints the build's summary, or its error and a failing exit code. */
export async function runBuild(script, build) {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--archive'))) {
    console.error(`Usage: ${script} [--archive FILE]`);
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await build(args[1]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
