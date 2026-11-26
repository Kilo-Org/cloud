import 'server-only';
import { timingSafeEqual } from '@kilocode/encryption';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';

/** Reads the internal API secret for one request and returns it as stored, empty included. */
export type InternalApiSecretRead = () => Promise<string>;

declare global {
  // Next.js evaluates a module once per bundle layer, so a read the web app installs from
  // `instrumentation.ts` reaches its route handlers only through a process-wide slot.
  var __kilocodeInternalApiSecretRead: InternalApiSecretRead | undefined;
}

/**
 * Called only by the web app (`apps/web/src/lib/sts-secret-reader.ts`), which owns the source
 * selection. The AI gateway, scripts and tests install nothing.
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

/**
 * Whether a caller presented the internal API secret. A request with no credential is refused
 * without a read; an empty configured secret matches nothing.
 */
export async function matchesInternalApiSecret(
  presented: string | null | undefined
): Promise<boolean> {
  if (!presented) return false;
  const expected = await readInternalApiSecret();
  return Boolean(expected) && timingSafeEqual(presented, expected);
}
