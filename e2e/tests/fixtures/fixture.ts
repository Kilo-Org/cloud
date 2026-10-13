import { test as baseTest } from '@anaconda/playwright-utils';
import { AppShellPage } from '@pages/ui/app-shell/app-shell-page';
import { GetStartedApi } from '@pages/api/auth/get-started-api';
import { GetStartedPage } from '@pages/ui/auth/get-started-page';
import { SeedData } from '@support/core/seed-data';
import { SessionPage } from '@pages/ui/auth/session-page';
import { installHydrationWait, neutralizeNextDevOverlay } from '@support/core/hydration';

type Fixtures = {
  seed: SeedData;
  sessionPage: SessionPage;
  appShellPage: AppShellPage;
  getStartedApi: GetStartedApi;
  getStartedPage: GetStartedPage;
};

export const test = baseTest.extend<Fixtures>({
  // Every test signs in as its own seeded user, never a shared session.
  storageState: { cookies: [], origins: [] },
  // Dev-overlay fix and hydration wait for every tab: `page` fires for the default page, `newPage()` and popups.
  context: async ({ context }, use) => {
    await neutralizeNextDevOverlay(context);
    context.on('page', installHydrationWait);
    await use(context);
  },
  seed: async ({}, use) => {
    await use(new SeedData());
  },
  sessionPage: async ({}, use) => {
    await use(new SessionPage());
  },
  appShellPage: async ({}, use) => {
    await use(new AppShellPage());
  },
  getStartedApi: async ({}, use) => {
    await use(new GetStartedApi());
  },
  getStartedPage: async ({}, use) => {
    await use(new GetStartedPage());
  },
});
