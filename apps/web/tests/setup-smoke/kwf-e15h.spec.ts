import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';

function log(label: string, value: unknown) {
  console.log(`### ${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function nameFieldText(d: import('@playwright/test').Locator) {
  return d.evaluate(el => {
    const input = Array.from(el.querySelectorAll('input')).find(
      i => i.placeholder === 'my-command'
    );
    if (!input) return 'NO-NAME-FIELD';
    const wrap = input.closest('div') ?? input.parentElement;
    return (wrap?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  });
}

test('e15h slash inline validation messages', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(`/users/sign_in?fakeUser=${encodeURIComponent(EMAIL)}`);
  await page.waitForURL(
    url => url.pathname === '/profile' || url.pathname.startsWith('/organizations/'),
    { timeout: 40_000 }
  );
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
  await d.getByText('LIVE SLASH2 1789837817461', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await d
    .getByRole('button', { name: /Add command/i })
    .first()
    .click();
  await page.waitForTimeout(1200);

  log('E15H-NAME-EMPTY', await nameFieldText(d));
  await d
    .getByRole('button', { name: /^Add command$/ })
    .last()
    .click();
  await page.waitForTimeout(1500);
  log('E15H-NAME-AFTER-EMPTY-SUBMIT', await nameFieldText(d));
  log('E15H-FORM-STILL-OPEN', (await d.innerText()).includes('Description (optional)'));
  await page.screenshot({ path: `${OUT}/e15h-slash-empty-submit.png`, fullPage: false });

  const name = d.locator('input[placeholder="my-command"]');
  await name.fill('Bad Name!');
  await page.waitForTimeout(800);
  log('E15H-NAME-INVALID-TYPED', await nameFieldText(d));
  await d
    .getByRole('button', { name: /^Add command$/ })
    .last()
    .click();
  await page.waitForTimeout(1200);
  log('E15H-NAME-AFTER-INVALID-SUBMIT', await nameFieldText(d));
  await page.screenshot({ path: `${OUT}/e15h-slash-invalid-submit.png`, fullPage: false });

  await name.fill('cmd-one');
  await page.waitForTimeout(800);
  log('E15H-NAME-DUPLICATE-TYPED', await nameFieldText(d));
  await d
    .getByRole('button', { name: /^Add command$/ })
    .last()
    .click();
  await page.waitForTimeout(1200);
  log('E15H-NAME-AFTER-DUPLICATE-SUBMIT', await nameFieldText(d));
  log('E15H-FORM-OPEN-AFTER-DUPLICATE', (await d.innerText()).includes('Description (optional)'));
  await page.screenshot({ path: `${OUT}/e15h-slash-duplicate-submit.png`, fullPage: false });

  const good = `kwf-h-${Date.now()}`;
  await name.fill(good);
  await page.waitForTimeout(800);
  log('E15H-NAME-VALID-TYPED', await nameFieldText(d));
  await d.locator('textarea').first().fill('body here');
  await d
    .getByRole('button', { name: /^Add command$/ })
    .last()
    .click();
  await page.waitForTimeout(2500);
  const txt = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15H-SLASH-ADDED', txt.includes(good));
  log('E15H-SLASH-COUNT', txt.slice(txt.indexOf('Slash Cmds')).slice(0, 20));
  await page.screenshot({ path: `${OUT}/e15h-slash-added.png`, fullPage: false });
});
