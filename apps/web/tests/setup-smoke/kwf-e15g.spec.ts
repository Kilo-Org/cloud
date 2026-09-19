import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';

function log(label: string, value: unknown) {
  console.log(`### ${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

test('e15g row markup + e18 language-switcher probe', async ({ page }) => {
  test.setTimeout(280_000);
  await page.goto(`/users/sign_in?fakeUser=${encodeURIComponent(EMAIL)}`);
  await page.waitForURL(
    url => url.pathname === '/profile' || url.pathname.startsWith('/organizations/'),
    { timeout: 40_000 }
  );

  // ---- e18: any locale/language control anywhere in the app shell ----
  await page.waitForTimeout(3000);
  const menu = page
    .locator('button')
    .filter({ hasText: /V5 Verify|v5-verify/i })
    .first();
  if (await menu.count()) {
    await menu.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  const menuItems = await page
    .locator('[role=menu] [role=menuitem], [role=menu] a, [role=menu] button')
    .allInnerTexts()
    .catch(() => [] as string[]);
  log(
    'E18G-USER-MENU',
    menuItems.map(s => s.replace(/\n+/g, ' | ').slice(0, 80))
  );
  const menuHasLang = menuItems.some(s => /language|locale|sprache|idioma|langue/i.test(s));
  log('E18G-MENU-HAS-LANGUAGE', menuHasLang);
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(800);
  await page.goto('/profile');
  await page.waitForTimeout(3500);
  const profileBody = await page.locator('body').innerText();
  log('E18G-PROFILE-HAS-LANGUAGE-CONTROL', /language|locale/i.test(profileBody));
  await page.screenshot({ path: `${OUT}/e18g-profile-language-probe.png`, fullPage: false });

  // ---- e15g: exact row markup on Setup + Slash tabs ----
  await page.goto('/cloud');
  await page.waitForTimeout(6000);
  await page
    .getByRole('button', { name: /No profile|V5 KEEP/ })
    .last()
    .click();
  await page.waitForTimeout(1500);
  await page.getByText('Manage profiles...', { exact: false }).first().click();
  await page.waitForTimeout(2500);
  const d = page.locator('[role=dialog]').last();

  // profile with 3 setup commands
  await d.getByText('E17B V 1789827425879', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await d
    .getByRole('button', { name: /^Setup/ })
    .first()
    .click();
  await page.waitForTimeout(1500);
  await d
    .getByText('echo', { exact: false })
    .first()
    .hover()
    .catch(() => {});
  await page.waitForTimeout(1000);
  const setupHtml = await d.evaluate(el => {
    const all = Array.from(el.querySelectorAll('*'));
    const target = all.filter(
      n => (n.textContent ?? '').includes('echo') && n.querySelectorAll('button').length > 0
    );
    const smallest = target[target.length - 1];
    return smallest
      ? (smallest as HTMLElement).outerHTML.replace(/\s+/g, ' ').slice(0, 2500)
      : 'NOT-FOUND';
  });
  log('E15G-SETUP-ROW-HTML', setupHtml);
  const setupText = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15G-SETUP-TEXT', setupText.slice(setupText.indexOf('Setup Commands')).slice(0, 200));
  await page.screenshot({ path: `${OUT}/e15g-setup-row.png`, fullPage: false });

  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(1500);
  const slashHtml = await d.evaluate(el => {
    const all = Array.from(el.querySelectorAll('*'));
    const target = all.filter(
      n => (n.textContent ?? '').includes('/') && n.querySelectorAll('button').length > 0
    );
    const smallest = target[target.length - 1];
    return smallest
      ? (smallest as HTMLElement).outerHTML.replace(/\s+/g, ' ').slice(0, 2500)
      : 'NOT-FOUND';
  });
  log('E15G-SLASH-ROW-HTML', slashHtml);
  log('E15G-ALL-MOVE-LABELS', await d.locator('[aria-label*="ove" i], [title*="ove" i]').count());
  await page.screenshot({ path: `${OUT}/e15g-slash-row.png`, fullPage: false });
});
