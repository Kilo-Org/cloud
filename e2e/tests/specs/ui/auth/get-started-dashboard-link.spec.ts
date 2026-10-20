import { test } from '@fixture';

/**
 * `/get-started`: a signed-out visitor is routed to the public install page, a signed-in visitor
 * stays in the app. Migrated from apps/web/tests/e2e/get-started-dashboard-link.spec.ts.
 */
test.describe('/get-started auth-aware router @reg', () => {
  test('redirects signed-out users to the landing install page', async ({ getStartedApi }) => {
    const response = await getStartedApi.requestGetStarted();
    getStartedApi.verifyRedirectsToInstall(response);
  });

  test('keeps signed-in users in the app', async ({ seed, sessionPage, getStartedPage }) => {
    const user = await seed.user({ prefix: 'get-started' });
    await sessionPage.signInAs(user);
    await getStartedPage.verifyOnSignedInDestination();

    await getStartedPage.navigateToGetStarted();
    await getStartedPage.verifyOnSignedInDestination();
  });
});
