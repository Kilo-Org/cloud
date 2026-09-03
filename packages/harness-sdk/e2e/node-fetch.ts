import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FetchLike } from '../src/core/fetch.js';

/**
 * The transport plugin needs a `fetch`. This is the whole Node adapter: about
 * ten lines, which is why the package declares the shape instead of depending
 * on a runtime.
 */
const decode = async function* decode(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    yield decoder.decode(chunk, { stream: true });
  }
};

export const nodeFetch: FetchLike = async (url, request) => {
  const response = await fetch(url, {
    method: request.method,
    headers: { ...request.headers },
    body: request.body,
    /* The package declares only the part of a signal it hands on, so the
       adapter names the type this runtime actually has. Dropping it would
       leave a cancelled call still running on the provider. */
    signal: (request.signal ?? null) as AbortSignal | null,
  });
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
    ...(response.body === null
      ? {}
      : { stream: () => decode(response.body as ReadableStream<Uint8Array>) }),
  };
};

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
