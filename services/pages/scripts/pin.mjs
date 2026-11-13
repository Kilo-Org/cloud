#!/usr/bin/env node
// Pin a published Pages release in `source.json`: `pnpm run pin pages-<build_id>`.
//
// Downloads the release's archive and digest file with `gh`, checks the
// digest, and verifies that nteract's release workflow attested the archive
// before it writes the tag and digest. The deploy checks the digest; this is
// where the archive's origin is checked, once, in the pull request that moves
// the pin.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAG, archiveName } from './package.mjs';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'nteract/nteract';
const SIGNER = `${REPOSITORY}/.github/workflows/pages-package-release.yml`;

const [tag, ...extra] = process.argv.slice(2);
if (!tag || extra.length || !TAG.test(tag)) {
  console.error('Usage: pin.mjs pages-<build_id>');
  process.exit(2);
}

const archive = archiveName(tag);
const work = mkdtempSync(path.join(tmpdir(), 'pages-pin-'));
try {
  const gh = (...args) =>
    execFileSync('gh', args, { cwd: work, stdio: ['ignore', 'pipe', 'inherit'] });
  gh(
    'release',
    'download',
    tag,
    '--repo',
    REPOSITORY,
    '--pattern',
    archive,
    '--pattern',
    `${archive}.sha256`
  );

  const digest = createHash('sha256')
    .update(readFileSync(path.join(work, archive)))
    .digest('hex');
  const [published, name] = readFileSync(path.join(work, `${archive}.sha256`), 'utf8')
    .trim()
    .split(/\s+/);
  if (published !== digest || name !== archive)
    throw new Error(
      `${archive} has sha256 ${digest}, but the release's digest file says ${published}`
    );

  gh('attestation', 'verify', archive, '--repo', REPOSITORY, '--signer-workflow', SIGNER);

  const source = { repository: REPOSITORY, tag, sha256: digest };
  writeFileSync(path.join(service, 'source.json'), JSON.stringify(source, null, 2) + '\n');
  console.log(JSON.stringify(source, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
