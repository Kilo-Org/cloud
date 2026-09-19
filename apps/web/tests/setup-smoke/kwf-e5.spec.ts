import { expect, test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';
const KEEP = 'V5 KEEP 1789830500';

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto(`/users/sign_in?fakeUser=${encodeURIComponent(email)}`);
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
    await page.waitForTimeout(2000);
  }
}

function log(label: string, value: unknown) {
  console.log(
    `### ${label} ${typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value)}`
  );
}

test('e5 webhook-referenced profile delete is refused with an explanation', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, EMAIL);

  await page.goto('/cloud');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/e5-cloud.png`, fullPage: false });

  // Open the session-start profile picker, then Manage profiles.
  const picker = page.getByRole('button', { name: /No profile|V5 KEEP/ }).last();
  await picker.click();
  await page.waitForTimeout(1500);
  await page.getByText('Manage profiles...', { exact: false }).first().click();
  await page.waitForTimeout(2500);
  const dialog = page.locator('[role=dialog]').last();
  log('E5-MANAGE', (await dialog.innerText()).replace(/\n{2,}/g, '\n').slice(0, 700));

  // Select the profile that a webhook trigger still references.
  await dialog.getByText(KEEP, { exact: true }).first().click();
  await page.waitForTimeout(1500);

  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/e5-confirm.png`, fullPage: false });
  const confirmBtn = dialog.getByRole('button', { name: 'Confirm', exact: true });
  await expect(confirmBtn).toBeVisible();
  log('E5-CONFIRM-VISIBLE', true);
  await confirmBtn.click();
  await page.waitForTimeout(4000);

  // Any toast / live region text shown after the refusal.
  const live = await page
    .locator('[role=status], [role=alert], [data-sonner-toast], li[data-sonner-toast]')
    .allInnerTexts()
    .catch(() => [] as string[]);
  log(
    'E5-LIVE-REGIONS',
    live.map(t => t.replace(/\n+/g, ' | ').slice(0, 400))
  );
  const toastHtml = await page
    .locator('[data-sonner-toast]')
    .first()
    .innerHTML()
    .catch(() => 'NO-TOAST');
  log('E5-TOAST-HTML', toastHtml.replace(/\s+/g, ' ').slice(0, 1200));
  const dialogText = (await dialog.innerText()).replace(/\n{2,}/g, '\n');
  log('E5-DIALOG-AFTER', dialogText.slice(0, 700));
  const stillListed = dialogText.includes(KEEP);
  log('E5-PROFILE-STILL-IN-LIST', stillListed);
  await page.screenshot({ path: `${OUT}/e5-after-refused-delete.png`, fullPage: false });

  // Contrast: an unreferenced profile deletes fine.
  const fresh = `E5 FREE ${Date.now()}`;
  await dialog.getByRole('button', { name: 'New profile' }).click();
  await page.waitForTimeout(1200);
  await dialog
    .getByPlaceholder(/Backend debugging/i)
    .first()
    .fill(fresh);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForTimeout(3000);
  const created = (await dialog.innerText()).includes(fresh);
  log('E5-FREE-CREATED', created);
  await dialog.getByText(fresh, { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForTimeout(1000);
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.waitForTimeout(3500);
  const afterFree = (await dialog.innerText()).replace(/\n{2,}/g, '\n');
  log('E5-FREE-STILL-IN-LIST', afterFree.includes(fresh));
  await page.screenshot({ path: `${OUT}/e5-free-deleted.png`, fullPage: false });

  expect(stillListed).toBe(true);
});
