#!/usr/bin/env node
// Build the Pages package for one deployment profile.
//
// Pages source lives in another repository. `source.json` pins the commit and
// `profiles/<name>.json` names the Worker and its resources. This script
// fetches exactly that commit, builds it, and writes a directory that
// `wrangler deploy --config <dir>/wrangler.json` publishes as it is.
//
// It runs the pinned repository's install and build scripts, so it takes no
// Cloudflare credential and makes no Cloudflare request. Run it where no
// deploy token is in the environment; the deploy workflow gives it a job of
// its own for that reason.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const COMMIT = /^[0-9a-f]{40}$/;
const REPOSITORY = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/;
const DIRECTORY = /^[\w.-]+(?:\/[\w.-]+)*$/;
const PROFILE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The pinned source: a full commit id, never a branch or tag, so the same
 * `source.json` always builds the same tree. */
function readSource() {
  const source = JSON.parse(readFileSync(path.join(service, 'source.json'), 'utf8'));
  if (typeof source.repository !== 'string' || !REPOSITORY.test(source.repository))
    throw new Error('source.json repository must be an https://github.com/OWNER/NAME.git URL');
  if (typeof source.commit !== 'string' || !COMMIT.test(source.commit))
    throw new Error('source.json commit must be a full 40-character commit id');
  if (
    typeof source.directory !== 'string' ||
    !DIRECTORY.test(source.directory) ||
    source.directory.split('/').includes('..')
  )
    throw new Error('source.json directory must be a path inside the repository');
  return source;
}

function run(command, args, cwd) {
  // Child output goes to stderr: stdout carries only the receipt.
  execFileSync(command, args, { cwd, stdio: ['ignore', process.stderr, process.stderr] });
}

function checkout(source, destination) {
  // Large files in the source repository belong to other applications. Leaving
  // them as pointers keeps the tree clean, which the packaging step requires.
  const env = { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' };
  const git = (...args) =>
    execFileSync('git', ['-C', destination, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', process.stderr],
    }).trim();
  git('init', '--quiet');
  git('fetch', '--quiet', '--depth=1', source.repository, source.commit);
  git('checkout', '--quiet', '--detach', 'FETCH_HEAD');
  const head = git('rev-parse', 'HEAD');
  if (head !== source.commit) throw new Error(`Fetched ${head}, expected ${source.commit}`);
}

function stage(profileName, destination) {
  if (!PROFILE.test(profileName ?? '')) throw new Error('Name a profile in profiles/, such as dev');
  const profile = path.join(service, 'profiles', `${profileName}.json`);
  if (!existsSync(profile)) throw new Error(`No profile at ${profile}`);
  if (!destination) throw new Error('Name a new directory for the package');
  destination = path.resolve(destination);
  if (existsSync(destination)) throw new Error(`${destination} exists; name a new directory`);

  const source = readSource();
  const checkoutDirectory = mkdtempSync(path.join(tmpdir(), 'pages-source-'));
  try {
    checkout(source, checkoutDirectory);
    const app = path.join(checkoutDirectory, source.directory);
    run('npm', ['ci'], app);
    run('npm', ['run', 'setup'], app);
    run('npm', ['run', 'build:upstream'], app);
    run('npm', ['run', 'build'], app);
    run('node', ['scripts/cloudflare-stage.mjs', destination, profile], app);
  } catch (error) {
    console.error(`The source tree is kept at ${checkoutDirectory}`);
    throw error;
  }
  rmSync(checkoutDirectory, { recursive: true, force: true });

  const { name } = JSON.parse(readFileSync(profile, 'utf8'));
  const { build_id } = JSON.parse(
    readFileSync(path.join(destination, 'build-receipt.json'), 'utf8')
  );
  return {
    profile: profileName,
    worker: name,
    repository: source.repository,
    commit: source.commit,
    build_id,
    config: path.join(destination, 'wrangler.json'),
  };
}

const [profileName, destination, ...extra] = process.argv.slice(2);
if (extra.length || !profileName || !destination) {
  console.error('Usage: stage.mjs PROFILE NEW_PACKAGE_DIRECTORY');
  process.exit(2);
}
try {
  console.log(JSON.stringify(stage(profileName, destination), null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
