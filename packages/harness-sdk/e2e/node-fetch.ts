import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { webFetch } from '../src/plugins/fetch/web.js';

/**
 * The transport plugin needs a `fetch`, and the package ships the adapter for a
 * runtime that has a WHATWG one. Every live run goes through it, which is how
 * the shipped adapter is proven rather than described.
 */
export const nodeFetch = webFetch;

/** Reads the kilo CLI token. The value is never printed. */
export const kiloToken = async (): Promise<string> => {
  const path = join(homedir(), '.local', 'share', 'kilo', 'auth.json');
  const auth: unknown = JSON.parse(await readFile(path, 'utf8'));
  const access = (auth as { kilo?: { access?: string } }).kilo?.access;
  if (access === undefined) {
    throw new Error(`no kilo token in ${path}; run \`kilo auth login\``);
  }
  return access;
};
