import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Fails when a module in `core/` reaches into `plugins/`.
 *
 * `core/` is the half of the package that runs on any runtime, and `plugins/`
 * is where every platform and every provider lives. A core module that reaches
 * into one takes the whole plugin with it, so the rule is that it does not.
 *
 * The rule used to be a negated `grep`: `! grep ... | grep -v ...`. The `!`
 * inverted the status of the whole pipeline, so a scan that could not run — a
 * moved `src/core`, a directory this process cannot read — produced no input,
 * the filter exited 1, and the gate reported success having read nothing. The
 * walk is here so a scan that cannot finish is the failure it is.
 */

const root = join(import.meta.dirname, '..');
const core = join(root, 'src/core');

/** Test code and fixtures wire a plugin to run against, so both are exempt. */
const exempt = /(?:\.test|-fixture)\.ts$/u;

const fail = (reason: string): never => {
  process.stdout.write(`${reason}\n`);
  process.exit(1);
};

const filesUnder = (folder: string): readonly string[] =>
  readdirSync(folder).flatMap(name => {
    const path = join(folder, name);
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith('.ts') ? [path] : [];
  });

const read = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch (cause) {
    return fail(`src/core cannot be read, so the boundary cannot be checked: ${String(cause)}`);
  }
};

const files = ((): readonly string[] => {
  try {
    return filesUnder(core);
  } catch (cause) {
    return fail(`src/core cannot be read, so the boundary cannot be checked: ${String(cause)}`);
  }
})();

/* A directory that is there and empty reads the same as one that was moved and
   recreated, and neither has been scanned. */
if (files.length === 0) {
  fail('src/core holds no TypeScript, so the boundary cannot be checked');
}

const offenders = files.filter(file => !exempt.test(file) && read(file).includes('plugins/'));

if (offenders.length === 0) {
  process.stdout.write('core/ does not reach into plugins/\n');
  process.exit(0);
}

process.stdout.write(
  `a core module reaches into plugins/. Move it under plugins/, or exempt it when it is test code:\n${offenders
    .map(file => `  ${relative(root, file)}`)
    .join('\n')}\n`
);
process.exit(1);
