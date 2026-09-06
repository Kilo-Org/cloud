import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The credential every live run needs, read from the kilo CLI's own file.
 *
 * The value is never printed, and nothing else in `e2e/` reads that file.
 *
 * The `fetch` these runs use is `webFetch`, imported from the package like any
 * consumer would. This file once re-exported it as `nodeFetch`, which named a
 * runtime the adapter does not have.
 */
const kiloToken = async (): Promise<string> => {
  const path = join(homedir(), '.local', 'share', 'kilo', 'auth.json');
  const auth: unknown = JSON.parse(await readFile(path, 'utf8'));
  const access = (auth as { kilo?: { access?: string } }).kilo?.access;
  if (access === undefined) {
    throw new Error(`no kilo token in ${path}; run \`kilo auth login\``);
  }
  return access;
};

export { kiloToken };
