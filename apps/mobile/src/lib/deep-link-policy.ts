import { parseKiloWebPath } from '@kilocode/app-shared/universal-links';

/**
 * Path of a link, decoded once, or null when the encoding is malformed.
 * `parseKiloWebPath` answers only for our own URL forms (the Kilo hosts and the
 * app scheme); a scheme-less path is what expo-router hands the warm handler.
 */
function decodedPath(raw: string): string | null {
  const pathname = (parseKiloWebPath(raw) ?? raw).split(/[?#]/, 1)[0] ?? '';
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

export function isRemovedMobileDeepLink(raw: string): boolean {
  const decodedPathname = decodedPath(raw);
  return (
    decodedPathname !== null &&
    /^\/(?:(?:\(app\)|\(tabs\))\/)*(?:claw|kiloclaw|chat|onboarding|\(1_kiloclaw\))(?:\/|$)/.test(
      decodedPathname
    )
  );
}
