import 'server-only';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/**
 * What a Pages deployment may ask Kilo about people, advertised on every
 * exchange answer as `directory.capabilities`. Pages shows a feature only when
 * its name is listed, and ignores names it doesn't know, so a name can be added
 * here without a Pages change.
 */
export type PagesDirectoryCapability = 'member_search';

/**
 * Organization member search for Pages, behind an operator setting that is off
 * unless exactly `true`. Turn it on only after both of the route's Vercel
 * Firewall rules exist: while it's off, the exchange mints no proof and the
 * route answers 404, so Pages keeps its picker hidden.
 */
export function isPagesMemberSearchEnabled(): boolean {
  return getEnvVariable('PAGES_MEMBER_SEARCH_ENABLED') === 'true';
}

export function pagesDirectoryCapabilities(): PagesDirectoryCapability[] {
  return isPagesMemberSearchEnabled() ? ['member_search'] : [];
}
