import { test, expect } from '@chromatic-com/playwright';
import { randomUUID } from 'crypto';

/**
 * Customer Source Survey E2E tests.
 *
 * Each test that needs a clean survey state (customer_source === null) creates
 * its own fresh user via the fake-login flow. This avoids shared-state issues
 * where one test's actions (submit/skip) poison subsequent tests.
 *
 * The helper `signInFreshUser` navigates through sign-in and stytch verification
 * with a brand-new email, landing the user at wherever the post-verification
 * redirect points (which should be /customer-source-survey once Task 6 is done).
 */

/**
 * Signs in a brand-new user via fake-login with stytchpass behavior.
 * Returns the final URL after sign-in + verification completes.
 *
 * Uses +stytchpass to auto-pass stytch verification so the user proceeds
 * through the full new-user flow: sign-in -> after-sign-in -> account-verification -> survey.
 */
async function signInFreshUser(page: import('@playwright/test').Page): Promise<string> {
  const uniqueId = randomUUID().slice(0, 8);
  const testEmail = `test-survey-${uniqueId}+stytchpass@example.com`;

  await page.goto(`/users/sign_in?fakeUser=${encodeURIComponent(testEmail)}`);

  // Wait for the full redirect chain to settle.
  // After Task 6, new users should land on /customer-source-survey.
  // Before Task 6, they land on /get-started.
  await page.waitForURL(
    url =>
      url.pathname === '/customer-source-survey' ||
      url.pathname === '/get-started' ||
      url.pathname === '/profile',
    { timeout: 30000, waitUntil: 'networkidle' }
  );

  return page.url();
}

test.describe('Customer Source Survey', () => {
  // These tests do NOT use the shared storageState from auth.setup.ts.
  // Each test creates its own user to ensure isolation.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('new user is redirected to survey after verification', async ({ page }) => {
    const finalUrl = await signInFreshUser(page);

    // After Task 6 (account-verification redirect change), new users should
    // land on /customer-source-survey instead of /get-started.
    expect(new URL(finalUrl).pathname).toBe('/customer-source-survey');
  });

  test('survey page displays expected content', async ({ page }) => {
    const finalUrl = await signInFreshUser(page);
    expect(new URL(finalUrl).pathname).toBe('/customer-source-survey');

    // Verify the page has the expected heading
    await expect(page.getByText('Where did you hear about Kilo Code?')).toBeVisible();

    // Verify the textarea placeholder is present
    await expect(page.getByPlaceholder('Example: A YouTube video from Theo')).toBeVisible();

    // Verify Submit button exists and is initially disabled (empty input)
    const submitButton = page.getByRole('button', { name: 'Submit' });
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toBeDisabled();

    // Verify Skip link exists
    await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible();
  });

  test('submit button is enabled only when textarea has content', async ({ page }) => {
    await signInFreshUser(page);

    const textarea = page.getByPlaceholder('Example: A YouTube video from Theo');
    const submitButton = page.getByRole('button', { name: 'Submit' });

    // Initially disabled
    await expect(submitButton).toBeDisabled();

    // Type something
    await textarea.fill('A friend told me');
    await expect(submitButton).toBeEnabled();

    // Clear it
    await textarea.fill('');
    await expect(submitButton).toBeDisabled();

    // Whitespace only should not enable (trim check)
    await textarea.fill('   ');
    await expect(submitButton).toBeDisabled();
  });

  test('submitting a response redirects to get-started', async ({ page }) => {
    await signInFreshUser(page);

    const textarea = page.getByPlaceholder('Example: A YouTube video from Theo');
    const submitButton = page.getByRole('button', { name: 'Submit' });

    await textarea.fill('Found it on Reddit');
    await submitButton.click();

    await page.waitForURL(url => url.pathname === '/get-started', {
      timeout: 15000,
    });
    expect(new URL(page.url()).pathname).toBe('/get-started');
  });

  test('skipping redirects to get-started', async ({ page }) => {
    await signInFreshUser(page);

    const skipLink = page.getByRole('button', { name: 'Skip' });
    await skipLink.click();

    await page.waitForURL(url => url.pathname === '/get-started', {
      timeout: 15000,
    });
    expect(new URL(page.url()).pathname).toBe('/get-started');
  });

  test('already-answered user is redirected past survey', async ({ page }) => {
    // First: sign in and submit a response
    await signInFreshUser(page);

    const textarea = page.getByPlaceholder('Example: A YouTube video from Theo');
    const submitButton = page.getByRole('button', { name: 'Submit' });

    await textarea.fill('Twitter post');
    await submitButton.click();

    await page.waitForURL(url => url.pathname === '/get-started', {
      timeout: 15000,
    });

    // Now navigate directly to the survey page. Since customer_source is set,
    // the server component should redirect past it.
    await page.goto('/customer-source-survey');

    await page.waitForURL(url => url.pathname === '/get-started', {
      timeout: 15000,
    });
    expect(new URL(page.url()).pathname).toBe('/get-started');
  });

  test('after skipping, revisiting survey should redirect away (H2 sentinel)', async ({ page }) => {
    // This test verifies the H2 bug fix: when a user clicks "Skip", a sentinel
    // value should be written to customer_source so that revisiting the survey
    // redirects past it. Without the fix, customer_source stays null and the
    // survey is shown again.
    await signInFreshUser(page);

    // Click Skip
    const skipLink = page.getByRole('button', { name: 'Skip' });
    await skipLink.click();

    await page.waitForURL(url => url.pathname === '/get-started', {
      timeout: 15000,
    });

    // Navigate back to the survey page directly
    await page.goto('/customer-source-survey');

    // If H2 is fixed (skip writes a sentinel), user should be redirected away.
    // If H2 is NOT fixed, user will see the survey form again.
    await page.waitForURL(
      url => url.pathname === '/get-started' || url.pathname === '/customer-source-survey',
      { timeout: 15000 }
    );

    // This assertion will FAIL until the H2 skip-persistence bug is fixed
    expect(new URL(page.url()).pathname).toBe('/get-started');
  });

  test('survey preserves callbackPath through submit', async ({ page }) => {
    await signInFreshUser(page);

    // If the user landed on /customer-source-survey, navigate with a callbackPath
    await page.goto('/customer-source-survey?callbackPath=%2Fprofile');

    const textarea = page.getByPlaceholder('Example: A YouTube video from Theo');
    const submitButton = page.getByRole('button', { name: 'Submit' });

    await textarea.fill('Hacker News');
    await submitButton.click();

    // Should redirect to /profile (the callbackPath), not /get-started
    await page.waitForURL(url => url.pathname === '/profile' || url.pathname === '/get-started', {
      timeout: 15000,
    });
    expect(new URL(page.url()).pathname).toBe('/profile');
  });

  test('survey preserves callbackPath through skip', async ({ page }) => {
    await signInFreshUser(page);

    await page.goto('/customer-source-survey?callbackPath=%2Fprofile');

    const skipLink = page.getByRole('button', { name: 'Skip' });
    await skipLink.click();

    // Should redirect to /profile (the callbackPath), not /get-started
    await page.waitForURL(url => url.pathname === '/profile' || url.pathname === '/get-started', {
      timeout: 15000,
    });
    expect(new URL(page.url()).pathname).toBe('/profile');
  });
});
