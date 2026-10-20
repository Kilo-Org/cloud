import { test } from '@fixture';
import { appShellCases } from '@testdata/ui/app-shell/app-shell-test-data';

/**
 * App shell accessibility for the signed-in app and the admin panel: skip link, a single main
 * landmark, the current nav item and touch-safe sidebar controls.
 * Migrated from apps/web/tests/e2e/app-shell-accessibility.spec.ts.
 */
test.describe('App shell accessibility @reg', () => {
  for (const shellCase of appShellCases) {
    test(`${shellCase.shell} shell: skip link, main landmark, current nav item and sidebar touch targets`, async ({
      seed,
      sessionPage,
      appShellPage,
    }) => {
      const user = await seed.user({ prefix: 'app-shell', isAdmin: shellCase.isAdmin });
      await sessionPage.signInAs(user, shellCase.path);
      await appShellPage.verifyOnPath(shellCase.landingPath);

      await appShellPage.verifySingleMainLandmark();
      await appShellPage.pressTab();
      await appShellPage.verifySkipLinkFocused();
      await appShellPage.pressEnter();
      await appShellPage.verifyMainContentFocused();
      await appShellPage.verifySidebarTouchTargets();
      await appShellPage.verifyHeaderHeight();
      await appShellPage.verifyNavItemCurrent(shellCase.currentNavItem);
    });
  }
});
