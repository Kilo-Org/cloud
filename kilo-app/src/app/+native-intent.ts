import { resolveDeepLink } from '@/lib/deep-link';

/**
 * Intercept incoming native URLs (universal links, custom scheme)
 * and rewrite them to internal app routes before Expo Router processes them.
 *
 * @see https://docs.expo.dev/router/advanced/native-intent/
 */
export function redirectSystemPath({
  path,
  initial: _initial,
}: {
  path: string;
  initial: boolean;
}): string {
  try {
    return resolveDeepLink(path);
  } catch {
    return path;
  }
}
