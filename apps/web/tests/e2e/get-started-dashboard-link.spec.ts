import { test, expect } from '@chromatic-com/playwright';
import { randomUUID } from 'crypto';

function isSignedInDestination(url: URL) {
  return url.pathname === '/profile' || url.pathname.startsWith('/organizations/');
}

test.describe('/get-started auth-aware router', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects signed-out users to the landing install page', async ({ request }) => {
    const response = await request.get('/get-started', { maxRedirects: 0 });

    expect([307, 308]).toContain(response.status());
    const location = response.headers().location;
    if (!location) throw new Error('Expected /get-started to return a redirect location');

    expect(new URL(location, 'http://localhost').pathname).toBe('/install');
  });

  test('keeps signed-in users in the app', async ({ page }) => {
    const uniqueId = randomUUID().slice(0, 8);
    const testEmail = `test-get-started-${uniqueId}+stytchpass@example.com`;

    await page.goto(`/users/sign_in?fakeUser=${encodeURIComponent(testEmail)}`);
    await page.waitForURL(
      url => url.pathname === '/customer-source-survey' || isSignedInDestination(url),
      { timeout: 30000, waitUntil: 'networkidle' }
    );

    if (new URL(page.url()).pathname === '/customer-source-survey') {
      await page.getByRole('button', { name: 'Skip' }).click();
      await page.waitForURL(url => isSignedInDestination(url), {
        timeout: 15000,
        waitUntil: 'networkidle',
      });
    }

    await page.goto('/get-started');
    await page.waitForURL(url => isSignedInDestination(url), {
      timeout: 15000,
      waitUntil: 'networkidle',
    });

    expect(isSignedInDestination(new URL(page.url()))).toBe(true);
  });
});
