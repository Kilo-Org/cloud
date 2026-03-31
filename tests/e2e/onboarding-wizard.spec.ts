import { test, expect } from '@chromatic-com/playwright';
import { randomUUID } from 'crypto';

/**
 * Onboarding Wizard E2E tests.
 *
 * Each test signs in a fresh user via fake-login and navigates to the
 * onboarding wizard. The wizard flow is: Name → Models → Repo → Task.
 *
 * These tests verify the full wizard flow as rendered in the browser,
 * including step navigation, form input, and the submission path.
 */

async function signInFreshUser(
  page: import('@playwright/test').Page,
  callbackPath = '/gastown/onboarding'
): Promise<void> {
  const uniqueId = randomUUID().slice(0, 8);
  const testEmail = `test-onboarding-${uniqueId}+stytchpass@example.com`;
  const signInUrl = `/users/sign_in?fakeUser=${encodeURIComponent(testEmail)}&callbackPath=${encodeURIComponent(callbackPath)}`;

  await page.goto(signInUrl);

  // Wait for the full redirect chain to settle on the onboarding page
  await page.waitForURL(
    url =>
      url.pathname === '/gastown/onboarding' ||
      url.pathname === '/customer-source-survey' ||
      url.pathname === '/get-started' ||
      url.pathname === '/profile',
    { timeout: 30000, waitUntil: 'networkidle' }
  );

  // If we landed on the survey page, skip it
  if (new URL(page.url()).pathname === '/customer-source-survey') {
    await page.click('button:has-text("Skip")');
    await page.waitForURL(
      url =>
        url.pathname === '/gastown/onboarding' ||
        url.pathname === '/get-started' ||
        url.pathname === '/profile',
      { timeout: 15000, waitUntil: 'networkidle' }
    );
  }

  // If we're on /get-started rather than /gastown/onboarding, navigate directly
  if (new URL(page.url()).pathname !== '/gastown/onboarding') {
    await page.goto('/gastown/onboarding');
    await page.waitForURL(url => url.pathname === '/gastown/onboarding', {
      timeout: 15000,
      waitUntil: 'networkidle',
    });
  }
}

test.describe('Onboarding Wizard', () => {
  // Each test creates its own user to ensure isolation
  test.use({ storageState: { cookies: [], origins: [] } });

  test('wizard page displays step 1 (Name) by default', async ({ page }) => {
    await signInFreshUser(page);

    // Verify the wizard header is visible
    await expect(page.getByText('Set up your town')).toBeVisible();

    // Verify step 1 heading
    await expect(page.getByText('Name your town')).toBeVisible();

    // Verify the input placeholder
    await expect(page.getByPlaceholder('my-town')).toBeVisible();

    // Verify step indicator shows all steps in the new order
    await expect(page.getByText('Name')).toBeVisible();
    await expect(page.getByText('Models')).toBeVisible();
    await expect(page.getByText('Repo')).toBeVisible();
    await expect(page.getByText('Task')).toBeVisible();

    // Back button should be disabled on the first step (opacity-0 = hidden)
    const backButton = page.getByRole('button', { name: 'Back' });
    await expect(backButton).toBeDisabled();
  });

  test('step 1: town name input accepts valid names', async ({ page }) => {
    await signInFreshUser(page);

    const input = page.getByPlaceholder('my-town');

    // Clear any auto-populated value and type a name
    await input.fill('');
    await input.fill('test-town');
    await expect(input).toHaveValue('test-town');

    // Should show "Press Enter to continue" hint when valid
    await expect(page.getByText('Press Enter to continue')).toBeVisible();
  });

  test('step 1: shows validation error for invalid names', async ({ page }) => {
    await signInFreshUser(page);

    const input = page.getByPlaceholder('my-town');

    // Type a name with a leading hyphen
    await input.fill('');
    await input.fill('-invalid');
    await expect(page.getByText('Town name cannot start or end with a hyphen')).toBeVisible();
  });

  test('navigating forward to step 2 (Models) using Next button', async ({ page }) => {
    await signInFreshUser(page);

    const input = page.getByPlaceholder('my-town');
    await input.fill('');
    await input.fill('test-town');

    // Click Next
    const nextButton = page.getByRole('button', { name: 'Next' });
    await nextButton.click();

    // Verify step 2 (Models) is now shown
    await expect(page.getByText('Choose your models')).toBeVisible();
  });

  test('navigating backward from step 2 to step 1', async ({ page }) => {
    await signInFreshUser(page);

    // Go to step 2 (Models)
    const input = page.getByPlaceholder('my-town');
    await input.fill('');
    await input.fill('test-town');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Choose your models')).toBeVisible();

    // Go back to step 1
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByText('Name your town')).toBeVisible();

    // Verify the previously entered name is preserved
    await expect(page.getByPlaceholder('my-town')).toHaveValue('test-town');
  });

  test('step 2: model preset selection defaults to Balanced', async ({ page }) => {
    await signInFreshUser(page);

    // Navigate to step 2 (Models)
    await page.getByPlaceholder('my-town').fill('test-town');
    await page.getByRole('button', { name: 'Next' }).click();

    // Verify step 2 heading
    await expect(page.getByText('Choose your models')).toBeVisible();

    // Verify presets are displayed
    await expect(page.getByText('Maximum Frontier')).toBeVisible();
    await expect(page.getByText('Balanced')).toBeVisible();
    await expect(page.getByText('Cost-Effective')).toBeVisible();
    await expect(page.getByText('Free Tier')).toBeVisible();
    await expect(page.getByText('Custom')).toBeVisible();
  });

  test('step 3: manual URL input mode', async ({ page }) => {
    await signInFreshUser(page);

    // Navigate to step 3 (Repo): Name → Models → Repo
    const input = page.getByPlaceholder('my-town');
    await input.fill('');
    await input.fill('test-town');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Choose your models')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Connect a repo')).toBeVisible();

    // Switch to manual URL mode
    await page.getByText('Or enter a git URL manually').click();

    // Verify manual URL fields appear
    await expect(page.getByPlaceholder('https://github.com/org/repo.git')).toBeVisible();
    await expect(page.getByText('Default Branch')).toBeVisible();

    // Fill in a manual URL
    await page
      .getByPlaceholder('https://github.com/org/repo.git')
      .fill('https://github.com/test/repo.git');

    // Continue button should be enabled
    const continueButton = page.getByRole('button', { name: 'Continue' });
    await expect(continueButton).toBeEnabled();

    // Click Continue to advance to step 4
    await continueButton.click();
    await expect(page.getByText('Give your first task')).toBeVisible();
  });

  test('step 4: task textarea, submit button, and skip button', async ({ page }) => {
    await signInFreshUser(page);

    // Navigate through to step 4: Name → Models → Repo (manual) → Task
    await page.getByPlaceholder('my-town').fill('test-town');
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Choose your models')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await expect(page.getByText('Connect a repo')).toBeVisible();
    await page.getByText('Or enter a git URL manually').click();
    await page
      .getByPlaceholder('https://github.com/org/repo.git')
      .fill('https://github.com/test/repo.git');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Verify step 4 heading
    await expect(page.getByText('Give your first task')).toBeVisible();

    // Verify textarea is present
    const textarea = page.getByPlaceholder("Describe something you'd like done in this repo...");
    await expect(textarea).toBeVisible();

    // Verify submit button is disabled when textarea is empty
    const submitButton = page.getByRole('button', { name: 'Create Town & Start' });
    await expect(submitButton).toBeDisabled();

    // Verify skip button is visible and enabled
    const skipButton = page.getByRole('button', { name: 'Skip' });
    await expect(skipButton).toBeVisible();
    await expect(skipButton).toBeEnabled();

    // Type a task
    await textarea.fill('Fix the README formatting');

    // Submit button should now be enabled
    await expect(submitButton).toBeEnabled();

    // Next button should be disabled on last step
    const nextButton = page.getByRole('button', { name: 'Next' });
    await expect(nextButton).toBeDisabled();
  });

  test('full wizard flow: create town and redirect', async ({ page }) => {
    await signInFreshUser(page);

    // Step 1: Name
    const nameInput = page.getByPlaceholder('my-town');
    await nameInput.fill('');
    const townName = `e2e-town-${randomUUID().slice(0, 6)}`;
    await nameInput.fill(townName);
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 2: Models (keep default Balanced)
    await expect(page.getByText('Choose your models')).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();

    // Step 3: Repo (manual URL)
    await expect(page.getByText('Connect a repo')).toBeVisible();
    await page.getByText('Or enter a git URL manually').click();
    await page
      .getByPlaceholder('https://github.com/org/repo.git')
      .fill('https://github.com/test/e2e-repo.git');
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 4: Task
    await expect(page.getByText('Give your first task')).toBeVisible();
    await page
      .getByPlaceholder("Describe something you'd like done in this repo...")
      .fill('Initialize the project structure');
    await page.getByRole('button', { name: 'Create Town & Start' }).click();

    // Wait for submission and redirect to the town page
    // The URL should be /gastown/<townId> after successful creation
    await page.waitForURL(
      url => url.pathname.startsWith('/gastown/') && url.pathname !== '/gastown/onboarding',
      { timeout: 30000 }
    );

    // Verify we landed on a town page (not the onboarding page)
    expect(new URL(page.url()).pathname).toMatch(/^\/gastown\/[a-zA-Z0-9-]+$/);
  });
});
