// What this folder takes from the Pages package: `output/worker.js`, the
// output shell, and the structural fields in `output/wrangler.json`.
//
// The archive is read and checked by `../pages/scripts/pinned.mjs`, the same
// code that builds the Pages Worker. These checks cover only the shell.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SHA256, printable } from '../../pages/scripts/package.mjs';
import { packageJson, sha256 } from '../../pages/scripts/pinned.mjs';

// Where `pnpm run build` puts the module, relative to `wrangler.jsonc`.
export const OUTPUT = 'dist';
/** The shell module, as the package and its build receipt name it. */
export const MODULE = 'output/worker.js';
/** The shell's structural Wrangler fields, as the package names them. */
export const CONFIG = 'output/wrangler.json';

/** Every structural field where `committed` (this folder's `wrangler.jsonc`)
 * differs from `packaged` (the package's `output/wrangler.json`); empty when
 * they agree. Today the package names `main`, `no_bundle` and
 * `compatibility_date`; a field it adds is compared the same way. `main` is
 * relative to `output/` in the package and to this folder here, so the two
 * differ by the `OUTPUT` prefix. */
export function shellConfigProblems(packaged, committed) {
  const expected = { ...packaged, main: `${OUTPUT}/${packaged.main}` };
  const problems = [];
  for (const name of Object.keys(expected).sort())
    if (!isDeepStrictEqual(expected[name], committed[name]))
      problems.push(`${printable(name)} in wrangler.jsonc differs from the package's ${CONFIG}`);
  return problems;
}

// A frame path is an absolute, versioned directory such as `/frame/v2/`.
const FRAME_PATH = /^\/([a-z0-9-]+\/)+$/;

/** Every reason the build receipt does not certify the shell module whose
 * sha256 is `digest`. The receipt lists the shell under `output_files`, alone,
 * and the paths it serves under `output_frame_paths`. */
export function receiptProblems(receipt, digest) {
  const files = receipt.output_files;
  if (files === null || typeof files !== 'object' || Array.isArray(files))
    return ['The build receipt has no output_files'];
  const names = Object.keys(files);
  const problems = [];
  if (names.length !== 1 || names[0] !== MODULE)
    problems.push(
      `The build receipt's output_files must name ${MODULE} alone, not ${printable(names.join(', '))}`
    );
  else if (typeof files[MODULE] !== 'string' || !SHA256.test(files[MODULE]))
    problems.push(`The build receipt's sha256 for ${MODULE} is not a digest`);
  else if (files[MODULE] !== digest)
    problems.push(
      `${MODULE} has sha256 ${digest}, but the build receipt certifies ${files[MODULE]}`
    );

  const paths = receipt.output_frame_paths;
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    !paths.every(entry => typeof entry === 'string' && FRAME_PATH.test(entry))
  )
    problems.push(
      "The build receipt's output_frame_paths must list frame paths such as /frame/v2/"
    );
  return problems;
}

/** Checks the shell in an opened package (`openPackage` in
 * `../pages/scripts/pinned.mjs`) against `committed` and its receipt, then
 * replaces `<service>/dist` with that one module at `committed.main`. Returns
 * the build's summary. */
export function buildShell({ staged, source, receipt }, committed, service) {
  const config = shellConfigProblems(packageJson(staged, CONFIG), committed);
  if (config.length) throw new Error(config.join('\n'));

  const module = readFileSync(path.join(staged, ...MODULE.split('/')));
  const certified = receiptProblems(receipt, sha256(module));
  if (certified.length) throw new Error(certified.join('\n'));

  const target = path.join(service, committed.main);
  rmSync(path.join(service, OUTPUT), { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, module);

  return {
    worker: committed.name,
    repository: source.repository,
    tag: source.tag,
    build_id: receipt.build_id,
    source_commit: receipt.source_sha,
    frame_paths: receipt.output_frame_paths,
  };
}
