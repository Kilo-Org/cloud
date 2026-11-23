#!/usr/bin/env node
// The checks `validate` runs, and the order it runs them in, live here once.
//
// The root manifest and the `apps/web` manifest each name this script as their
// `validate` entry point instead of spelling the chain out again, so a package
// cannot run a chain that has drifted from the others. The steps a package does
// not provide are either skipped (`format:changed:check`, which only makes sense
// where a package formats its own files) or refuse the run, so renaming or
// dropping one step fails here with its name instead of quietly removing a
// check from the chain.
//
// Usage:
//   node scripts/validate.mjs          # run the chain, stopping at the first failure
//   node scripts/validate.mjs --list   # print each step and whether it runs, run nothing

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// The one ordered list every caller reads. Required steps must exist in the
// manifest that runs them; optional steps are skipped when it lacks them.
export const STEP_ORDER = [
  'typecheck',
  'lint',
  'format:changed:check',
  'test',
  'dependency-cycle-check',
];

const OPTIONAL_STEPS = new Set(['format:changed:check']);

export class MissingStepError extends Error {
  constructor(steps, dir) {
    const noun = steps.length === 1 ? 'script' : 'scripts';
    super(`package.json in ${dir} does not define the required ${noun}: ${steps.join(', ')}`);
    this.name = 'MissingStepError';
    this.steps = steps;
  }
}

// Resolve the manifest's scripts into the steps to run, in order.
export function resolveSteps(manifest, dir = process.cwd()) {
  const scripts = manifest?.scripts ?? {};
  const missing = STEP_ORDER.filter(name => !OPTIONAL_STEPS.has(name) && !scripts[name]);
  if (missing.length > 0) throw new MissingStepError(missing, dir);
  return STEP_ORDER.map(name => ({ name, run: Boolean(scripts[name]) }));
}

// One line per step, each prefixed with whether it will run.
export function describeSteps(steps) {
  return steps.map(({ name, run }) => `${run ? 'run' : 'skip'} ${name}`).join('\n');
}

function readManifest(dir) {
  const file = path.join(dir, 'package.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${error.message}`);
  }
}

export function run(argv, dir = process.cwd()) {
  const args = argv.slice(2);
  if (args.length > 0 && !(args.length === 1 && args[0] === '--list')) {
    console.error(`validate: unknown argument: ${args.join(' ')}`);
    console.error('usage: node scripts/validate.mjs [--list]');
    return 2;
  }

  let steps;
  try {
    steps = resolveSteps(readManifest(dir), dir);
  } catch (error) {
    console.error(`validate: ${error.message}`);
    return 1;
  }

  if (args.length === 1) {
    console.log(describeSteps(steps));
    return 0;
  }

  for (const { name, run: selected } of steps) {
    if (!selected) {
      console.log(`[validate] skip ${name}`);
      continue;
    }
    console.log(`[validate] run ${name}`);
    const result = spawnSync('pnpm', ['run', name], { cwd: dir, stdio: 'inherit' });
    if (result.error) {
      console.error(`[validate] cannot start pnpm for ${name}: ${result.error.message}`);
      return 1;
    }
    // A step killed by a signal has no exit code; report the failure the way a
    // non-zero exit would, so a signal never reads as a pass.
    const code = result.status ?? 1;
    if (code !== 0) {
      console.error(`[validate] ${name} failed with exit code ${code}`);
      return code;
    }
  }
  return 0;
}

/**
 * Whether this module is the process entry point.
 *
 * `import.meta.main` needs Node 24.2, and the manifest admits older 24 releases where the
 * chain would silently run nothing. Comparing the module URL with the invoked path answers the
 * same question on every supported version.
 */
export function isMainModule(moduleUrl, invokedPath) {
  if (!invokedPath) return false;
  return moduleUrl === pathToFileURL(invokedPath).href;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = run(process.argv);
}
