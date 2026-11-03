/** Paths under this prefix belong to the preview hop and never reach the sandbox. */
export const PREVIEW_PATH_PREFIX = '/.kilo-preview';

const PREVIEW_RETURN_PATH_MAX_LENGTH = 2_048;
const RESOLVE_BASE = 'http://preview.invalid';

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function isPreviewReservedPath(pathname: string): boolean {
  return pathname === PREVIEW_PATH_PREFIX || pathname.startsWith(`${PREVIEW_PATH_PREFIX}/`);
}

/**
 * The location the entry redirects to after it sets the cookie. The value comes
 * from the client, so only a path on the preview host itself is kept. Any other
 * value, including a scheme, a host or a preview hop path, lands on `/`.
 */
export function previewReturnPath(raw: string | null): string {
  if (raw === null || raw.length === 0 || raw.length > PREVIEW_RETURN_PATH_MAX_LENGTH) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  if (hasControlCharacter(raw)) return '/';
  let resolved: URL;
  try {
    resolved = new URL(raw, RESOLVE_BASE);
  } catch {
    return '/';
  }
  if (resolved.origin !== RESOLVE_BASE || isPreviewReservedPath(resolved.pathname)) return '/';
  if (!resolved.pathname.startsWith('/') || resolved.pathname.startsWith('//')) return '/';
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
