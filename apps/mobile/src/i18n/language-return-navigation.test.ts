import { describe, expect, it } from 'vitest';

import { languageReturnNavigation } from '@/i18n/language-return-navigation';

/**
 * A language reload reopens the screen the user was on. A screen above its
 * tab's root must reopen with the anchors beneath it: a replaced or pushed
 * route alone becomes its Stack's only route, and Back then leaves the tab for
 * Home instead of returning to the tab root.
 */
describe('language return navigation', () => {
  it('reopens Preferences with the anchors beneath it', () => {
    expect(languageReturnNavigation('preferences')).toEqual({
      method: 'navigate',
      href: '/(app)/(tabs)/(3_profile)/preferences',
      withAnchor: true,
    });
  });

  it('replaces the Profile tab root, which is its own parent', () => {
    expect(languageReturnNavigation('profile')).toEqual({
      method: 'replace',
      href: '/(app)/(tabs)/(3_profile)',
    });
  });

  it('replaces the signed-out screen, which has no shell anchors', () => {
    expect(languageReturnNavigation('login')).toEqual({
      method: 'replace',
      href: '/(auth)/login',
    });
  });
});
