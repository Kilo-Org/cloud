import { test, expect } from '@chromatic-com/playwright';
import { randomUUID } from 'crypto';

test.describe('/get-started dashboard escape hatch', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('hides the dashboard link for signed-out users', async ({ page }) => {
    await page.goto('/get-started');

    const skipLink = page.getByRole('link', { name: /skip to dashboard/i });
    await expect(skipLink).toHaveCount(0);

    const signInLink = page.getByRole('link', { name: /sign in/i });
    await expect(signInLink).toBeVisible();
    await expect(signInLink).toHaveAttribute('href', '/users/sign_in?callbackPath=/get-started');
  });

  test('shows the dashboard link after fake login and survey skip', async ({ page }) => {
    const uniqueId = randomUUID().slice(0, 8);
    const testEmail = `test-get-started-${uniqueId}+stytchpass@example.com`;

    await page.goto(`/users/sign_in?fakeUser=${encodeURIComponent(testEmail)}`);
    await page.waitForURL(
      url =>
        url.pathname === '/customer-source-survey' ||
        url.pathname === '/get-started' ||
        url.pathname === '/profile',
      { timeout: 30000, waitUntil: 'networkidle' }
    );

    if (new URL(page.url()).pathname === '/customer-source-survey') {
      await page.getByRole('button', { name: 'Skip' }).click();
      await page.waitForURL(url => url.pathname === '/get-started' || url.pathname === '/profile', {
        timeout: 15000,
        waitUntil: 'networkidle',
      });
    }

    await page.goto('/get-started');
    const skipLink = page.getByRole('link', { name: /skip to dashboard/i });
    await expect(skipLink).toBeVisible();
    await expect(skipLink).toHaveAttribute('href', '/profile');
  });
});
