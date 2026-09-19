import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';
const SLASH_PROFILE = 'LIVE SLASH2 1789837817461';

function log(label: string, value: unknown) {
  const s = typeof value === 'string' ? value.replace(/\n{2,}/g, '\n') : JSON.stringify(value);
  console.log(`### ${label} ${s}`);
}

test('e18 locale probe + e15 inline validation detail', async ({ page }) => {
  test.setTimeout(200_000);
  page.setDefaultTimeout(8000);

  // ---- e18: is there any locale switch on the web? ----
  await page.goto(`/users/sign_in?fakeUser=${encodeURIComponent(EMAIL)}`);
  await page.waitForURL(
    url => url.pathname === '/profile' || url.pathname.startsWith('/organizations/'),
    {
      timeout: 40_000,
    }
  );
  await page.goto('/profile');
  await page.waitForTimeout(3000);
  log('E18-HTML-LANG', await page.evaluate(() => document.documentElement.lang));
  log(
    'E18-LANG-CONTROLS',
    await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a, [role=menuitem], select, option'))
        .map(n => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(t => /language|locale|deutsch|english|français|español|日本語/i.test(t))
        .slice(0, 10)
    )
  );
  // try to force a German catalog via a locale cookie and see if the UI changes
  await page
    .context()
    .addCookies([{ name: 'NEXT_LOCALE', value: 'de', url: 'http://localhost:3700' }]);
  await page.goto('/cloud');
  await page.waitForTimeout(4000);
  log('E18-AFTER-DE-COOKIE-HTML-LANG', await page.evaluate(() => document.documentElement.lang));
  log(
    'E18-AFTER-DE-COOKIE-GERMAN-WORDS',
    await page.evaluate(() => {
      const t = document.body.innerText;
      return ['Profil', 'Sprache', 'Umgebung', 'Einstellungen', 'Abmelden'].filter(w =>
        t.includes(w)
      );
    })
  );

  // ---- e15: inline validation detail on the slash command form ----
  await page
    .getByRole('button', { name: /No profile|V5 KEEP/ })
    .last()
    .click();
  await page.waitForTimeout(1200);
  await page.getByText('Manage profiles...', { exact: false }).first().click();
  await page.waitForTimeout(2000);
  const d = page.locator('[role=dialog]').last();
  await d.getByText(SLASH_PROFILE, { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(800);
  await d
    .getByRole('button', { name: /Add command/i })
    .first()
    .click();
  await page.waitForTimeout(900);

  const nameInput = d.locator('input').first();
  await nameInput.fill('Bad Name!');
  await page.waitForTimeout(700);
  log('E15W-NAME-AFTER-TYPE', await nameInput.inputValue());
  log(
    'E15W-NAME-FIELD-WRAP',
    await nameInput.evaluate(el =>
      (el.closest('div')?.parentElement?.innerText ?? '').replace(/\n{2,}/g, '\n').slice(0, 200)
    )
  );
  await page.screenshot({ path: `${OUT}/e15w-name-invalid.png`, fullPage: false });

  await nameInput.fill('1bad');
  await page.waitForTimeout(700);
  log('E15W-NAME2-AFTER-TYPE', await nameInput.inputValue());
  log(
    'E15W-NAME2-FIELD-WRAP',
    await nameInput.evaluate(el =>
      (el.closest('div')?.parentElement?.innerText ?? '').replace(/\n{2,}/g, '\n').slice(0, 200)
    )
  );

  // valid name, empty template -> submit
  await nameInput.fill(`kwfw-${Date.now()}`);
  await page.waitForTimeout(400);
  await d
    .getByRole('button', { name: /^Add command$/ })
    .last()
    .click();
  await page.waitForTimeout(1800);
  log(
    'E15W-EMPTY-TEMPLATE-TOASTS',
    await page
      .locator('[data-sonner-toast]')
      .allInnerTexts()
      .catch(() => [] as string[])
  );
  const formTxt = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15W-EMPTY-TEMPLATE-FORM', formTxt.slice(formTxt.lastIndexOf('Name')).slice(0, 220));
  await page.screenshot({ path: `${OUT}/e15w-empty-template.png`, fullPage: false });
});
