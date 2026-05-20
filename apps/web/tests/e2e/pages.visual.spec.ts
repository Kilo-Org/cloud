import { test } from '@chromatic-com/playwright';
import { mkdir } from 'fs/promises';
import { join } from 'path';

/**
 * Visual regression test for all top-level pages.
 * Screenshots all pages that can be accessed directly (not nested under dynamic routes).
 */
test.describe('Top-Level Pages', () => {
  const pages = [
    // Main app pages (require auth)
    { name: 'Profile', url: '/profile' },
    { name: 'Organizations', url: '/organizations' },
    { name: 'Organizations New', url: '/organizations/new' },
    { name: 'Credits', url: '/credits' },
    { name: 'Cloud', url: '/cloud' },
    { name: 'Cloud Chat', url: '/cloud/chat' },
    { name: 'Cloud Sessions', url: '/cloud/sessions' },
    { name: 'App Builder', url: '/app-builder' },
    { name: 'Code Indexing', url: '/code-indexing' },
    { name: 'Code Reviewer', url: '/code-reviews' },
    { name: 'Deploy', url: '/deploy' },
    { name: 'Usage', url: '/usage' },
    { name: 'Invoices', url: '/invoices' },
    { name: 'Integrations', url: '/integrations' },
    { name: 'Integrations GitHub', url: '/integrations/github' },
    { name: 'Billing', url: '/billing' },
    { name: 'Connected Accounts', url: '/connected-accounts' },
    { name: 'Account Deleted', url: '/account-deleted' },
    // Onboarding/auth pages
    { name: 'Get Started', url: '/get-started' },
    { name: 'Welcome', url: '/welcome' },
    { name: 'Device Auth', url: '/device-auth?code=FOOBAR' },
    { name: 'Sign In To Editor', url: '/sign-in-to-editor' },
  ];

  const screenshotsDir = join(process.cwd(), 'test-results', 'screenshots');
  test.beforeAll(async () => {
    await mkdir(screenshotsDir, { recursive: true });
  });

  for (const page of pages) {
    test(`should screenshot ${page.name}`, async ({ page: playwrightPage }) => {
      await playwrightPage.goto(page.url);

      try {
        await playwrightPage.waitForLoadState('networkidle', { timeout: 10000 });
      } catch {
        await playwrightPage.waitForLoadState('load');
      }
      await playwrightPage.waitForTimeout(5000);

      // Create a sanitized filename from the page name
      const filename = page.name.toLowerCase().replace(/\s+/g, '-') + '.png';
      const filepath = join(screenshotsDir, filename);

      await playwrightPage.screenshot({ path: filepath, fullPage: true });
    });
  }
});
