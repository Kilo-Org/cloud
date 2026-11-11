import { parseKiloWebPath } from '@kilocode/app-shared/universal-links';

export function isRemovedMobileDeepLink(raw: string): boolean {
  const pathname = (parseKiloWebPath(raw) ?? raw).split(/[?#]/, 1)[0] ?? '';
  try {
    const decodedPath = decodeURIComponent(pathname);
    return /^\/(?:(?:\(app\)|\(tabs\))\/)*(?:claw|kiloclaw|chat|onboarding|\(1_kiloclaw\))(?:\/|$)/.test(
      decodedPath
    );
  } catch {
    return false;
  }
}
