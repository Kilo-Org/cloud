import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';

function isSignedInDestination(url: URL): boolean {
  return url.pathname === '/profile' || url.pathname.startsWith('/organizations/');
}

test.describe('local setup smoke', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('signs in with fake auth and renders the profile page', async ({ page }) => {
    const uniqueId = randomUUID().slice(0, 8);
    const testEmail = `setup-smoke-${uniqueId}+stytchpass@example.com`;
    const signInUrl = `/users/sign_in?fakeUser=${encodeURIComponent(testEmail)}&callbackPath=${encodeURIComponent('/profile')}`;

    await page.goto(signInUrl);
    await page.waitForURL(
      url => url.pathname === '/customer-source-survey' || isSignedInDestination(url),
      { timeout: 30_000, waitUntil: 'networkidle' }
    );

    if (new URL(page.url()).pathname === '/customer-source-survey') {
      await page.getByRole('button', { name: 'Skip' }).click();
      await page.waitForURL(url => isSignedInDestination(url), {
        timeout: 15_000,
        waitUntil: 'networkidle',
      });
    }

    const profileResponse = await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    expect(profileResponse?.ok()).toBe(true);
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
    await expect(page.getByText(testEmail)).toBeVisible();
  });
});
