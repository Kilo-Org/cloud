import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = process.env.KWF_E15_EMAIL ?? 'kwf-e15-live@example.com';

test('e15a sign in a fresh empty account and capture /cloud', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/users/sign_in?fakeUser=${encodeURIComponent(EMAIL)}`);
  await page.waitForURL(
    url =>
      url.pathname === '/profile' ||
      url.pathname.startsWith('/organizations/') ||
      url.pathname === '/customer-source-survey',
    { timeout: 40_000 }
  );
  if (new URL(page.url()).pathname === '/customer-source-survey') {
    await page
      .getByRole('button', { name: /skip/i })
      .click()
      .catch(() => {});
    await page.waitForTimeout(2500);
  }
  console.log(`### E15A-EMAIL ${EMAIL}`);
  console.log(`### E15A-URL ${page.url()}`);
  await page.goto('/cloud');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/e15a-cloud-no-repo.png`, fullPage: false });
  console.log(
    `### E15A-HAS-CONNECT-REPO ${/Connect a repository provider/.test(await page.locator('body').innerText())}`
  );
});
