import { expect, test } from '@playwright/test';
import { createDrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { hosted_domain_specials } from '@/lib/auth/constants';
import { randomUUID } from 'node:crypto';

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
        customer_source: 'Setup smoke test',
        has_validation_stytch: true,
      });
    } finally {
      await pool.end();
    }

    await page.goto(signInUrl);
    await page.waitForURL(url => url.pathname === '/profile', { timeout: 30_000 });

    const profileCard = page.getByRole('region', { name: 'User profile' });
    await expect(profileCard).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('link', { name: 'Your Profile' })).toBeVisible();
    await expect(profileCard.getByRole('button', { name: 'Edit profile' })).toBeVisible();
    await expect(profileCard.getByText(testEmail, { exact: true })).toBeVisible();
  });
});
