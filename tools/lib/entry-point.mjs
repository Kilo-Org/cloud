import { pathToFileURL } from 'node:url';

/**
 * Runs `run` only when `moduleUrl`'s file is the process entry point.
 *
 * `process.argv[1]` is a path and `import.meta.url` is a URL, so the entry path
 * is converted here: one definition keeps the audits from drifting into a
 * second normalisation.
 */
export function runIfMain(run, moduleUrl) {
  if (process.argv[1] !== undefined && moduleUrl === pathToFileURL(process.argv[1]).href) {
    run();
  }
}
