import { expect, test } from '@playwright/test';
import { createDrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { hosted_domain_specials } from '@/lib/auth/constants';
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
    const postgresUrl = process.env.POSTGRES_URL;
    if (!postgresUrl) throw new Error('POSTGRES_URL must be set for setup smoke tests');

    const { db, pool } = createDrizzleClient({
      connectionString: postgresUrl,
      poolConfig: {
        connectionTimeoutMillis: Number.parseInt(process.env.POSTGRES_CONNECT_TIMEOUT ?? '30000'),
        max: 1,
      },
    });

    try {
      await db.insert(kilocode_users).values({
        id: `setup-smoke-${uniqueId}`,
        google_user_email: testEmail,
        google_user_name: `setup-smoke-${uniqueId}`,
        google_user_image_url: '',
        hosted_domain: hosted_domain_specials.fake_devonly,
        stripe_customer_id: `cus_setup_smoke_${uniqueId}`,
        completed_welcome_form: true,
        has_validation_stytch: true,
      });
    } finally {
      await pool.end();
    }

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
    await expect(page.getByRole('link', { name: 'Your Profile' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Edit profile' })).toBeVisible();
    await expect(page.getByText(testEmail)).toBeVisible();
  });
});
