import { describe, expect, it } from 'vitest';

import { DEV_CLIENT_PLUGIN_OPTIONS } from './dev-client-plugin';

// Mirrored, not imported: the point is that the values keep the developer menu
// off the product screens, and a test that read them back out of the module
// would still pass after the overlay was switched back on. On iOS expo-dev-menu
// auto-shows over the app at launch while onboarding is unfinished or
// EXDevMenuShowsAtLaunch is set, and its icons carry raw SF Symbol names --
// `chevron.left.chevron.right` on "Open DevTools" -- as the accessibility
// labels a scene dump of the product screen under it reads aloud as-is.
const EXPECTED = {
  toolsButton: false,
  showMenuAtLaunch: false,
  skipOnboarding: true,
};

describe('expo-dev-client plugin options', () => {
  it('keeps the developer menu off the product screens', () => {
    expect(DEV_CLIENT_PLUGIN_OPTIONS).toEqual(EXPECTED);
  });
});
