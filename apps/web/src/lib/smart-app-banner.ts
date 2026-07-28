import { APP_URL } from '@/lib/constants';
import { webPathToAppPath } from '@kilocode/app-shared/universal-links';

const IOS_APP_STORE_ID = '6761193135';

/**
 * Apple Smart App Banner `itunes` metadata.
 *
 * Call with no path for the site-wide banner (appId only). Call with a web path
 * to set `app-argument` so OPEN deep-links into the matching app screen.
 *
 * Throws when `path` is not deep-linkable: metadata is evaluated at build time,
 * so an unmapped path fails the build instead of shipping an OPEN button that
 * dumps users on the home screen.
 */
export function smartAppBannerItunes(): { appId: string };
export function smartAppBannerItunes(path: string): { appId: string; appArgument: string };
export function smartAppBannerItunes(
  path?: string
): { appId: string } | { appId: string; appArgument: string } {
  if (path === undefined) {
    return { appId: IOS_APP_STORE_ID };
  }

  if (webPathToAppPath(path) === null) {
    throw new Error(
      `smartAppBannerItunes: path "${path}" is not deep-linkable (webPathToAppPath returned null)`
    );
  }

  return { appId: IOS_APP_STORE_ID, appArgument: `${APP_URL}${path}` };
}
