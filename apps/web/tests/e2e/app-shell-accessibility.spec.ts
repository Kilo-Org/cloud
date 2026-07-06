import { test, expect } from '@chromatic-com/playwright';
import { createDrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { randomUUID } from 'node:crypto';
import { hosted_domain_specials } from '@/lib/auth/constants';

async function seedFakeUser({ isAdmin }: { isAdmin: boolean }) {
  const uniqueId = randomUUID().slice(0, 8);
  const testEmail = `app-shell-${uniqueId}+stytchpass@example.com`;
  const postgresUrl = process.env.POSTGRES_URL;
  if (!postgresUrl) throw new Error('POSTGRES_URL must be set for app shell tests');

  const { db, pool } = createDrizzleClient({
    connectionString: postgresUrl,
    poolConfig: {
      connectionTimeoutMillis: Number.parseInt(process.env.POSTGRES_CONNECT_TIMEOUT ?? '30000'),
      max: 1,
    },
  });

  try {
    await db.insert(kilocode_users).values({
      id: `app-shell-${uniqueId}`,
      google_user_email: testEmail,
      google_user_name: `app-shell-${uniqueId}`,
      google_user_image_url: '',
      hosted_domain: hosted_domain_specials.fake_devonly,
      stripe_customer_id: `cus_app_shell_${uniqueId}`,
      completed_welcome_form: true,
      customer_source: 'App shell test',
      has_validation_stytch: true,
      is_admin: isAdmin,
    });
  } finally {
    await pool.end();
  }

  return testEmail;
}

async function expectShellBasics(page: import('@playwright/test').Page) {
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  const main = page.getByRole('main');

  await expect(main).toHaveCount(1);
  await expect(main).toBeVisible();
  await expect(main).toHaveAttribute('id', 'main-content');

  await page.keyboard.press('Tab');
  await expect(skipLink).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();

  const sidebarControls = page.getByRole('button', { name: 'Toggle sidebar' });
  await expect(sidebarControls).toHaveCount(1);

  for (const control of await sidebarControls.all()) {
    const box = await control.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }

  const sidebarRail = page.locator('[data-sidebar="rail"]');
  await expect(sidebarRail).toHaveAttribute('tabindex', '-1');

  const railBox = await sidebarRail.boundingBox();
  expect(railBox?.width).toBeLessThan(44);
}

test.describe('authenticated app shell accessibility', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('exposes skip link, single main landmark, current nav state, and touch-safe sidebar controls', async ({
    page,
  }) => {
    const testEmail = await seedFakeUser({ isAdmin: false });
    await page.goto(
      `/users/sign_in?fakeUser=${encodeURIComponent(testEmail)}&callbackPath=${encodeURIComponent('/install')}`
    );
    await page.waitForURL(url => url.pathname === '/install', { timeout: 30_000 });

    await expectShellBasics(page);
    await expect(page.locator('header').first()).toHaveCSS('height', '56px');

    await expect(
      page.locator('[data-sidebar="menu"]').getByRole('link', { name: /^Install$/ })
    ).toHaveAttribute('aria-current', 'page');
  });

  test.describe('admin shell', () => {
    test('exposes admin shell landmarks, current nav state, and canonical topbar', async ({
      page,
    }) => {
      const testEmail = await seedFakeUser({ isAdmin: true });
      await page.goto(
        `/users/sign_in?fakeUser=${encodeURIComponent(testEmail)}&callbackPath=${encodeURIComponent('/admin')}`
      );
      await page.waitForURL(url => url.pathname === '/admin/users', { timeout: 30_000 });

      await expectShellBasics(page);
      await expect(page.locator('header').first()).toHaveCSS('height', '56px');
      await expect(
        page.locator('[data-sidebar="menu"]').getByRole('link', { name: /^Users$/ })
      ).toHaveAttribute('aria-current', 'page');
    });
  });
});
