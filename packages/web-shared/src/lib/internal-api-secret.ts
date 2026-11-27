import 'server-only';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';

/** Reads the internal API secret for one request and returns it as stored, empty included. */
export type InternalApiSecretRead = () => Promise<string>;

declare global {
  // Next.js evaluates a module once per bundle layer, so a read an app installs from
  // `instrumentation.ts` reaches its route handlers only through a process-wide slot.
  var __kilocodeInternalApiSecretRead: InternalApiSecretRead | undefined;
}

/**
 * Called only by `sts-secret-reader.ts`, which owns the source selection, from the
 * `instrumentation.ts` of `apps/web` and `apps/ai-gateway`. Scripts and tests install nothing.
 */
export function installInternalApiSecretRead(read: InternalApiSecretRead): void {
  globalThis.__kilocodeInternalApiSecretRead = read;
}

/**
 * The internal API secret: the installed read when the app installed one (its failures reject),
 * otherwise this process's `INTERNAL_API_SECRET` value as before. An empty value stays empty, so
 * every caller keeps its own missing-secret handling.
 */
export async function readInternalApiSecret(): Promise<string> {
  const read = globalThis.__kilocodeInternalApiSecretRead;
  return read === undefined ? INTERNAL_API_SECRET : read();
}
