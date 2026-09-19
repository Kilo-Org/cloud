import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';

function log(label: string, value: unknown) {
  const s = typeof value === 'string' ? value.replace(/\n{2,}/g, '\n') : JSON.stringify(value);
  console.log(`### ${label} ${s}`);
}

async function dump(scope: import('@playwright/test').Locator, tag: string) {
  const btns = await scope.locator('button').all();
  const out: unknown[] = [];
  for (const b of btns) {
    out.push({
      t: (await b.innerText().catch(() => '')).replace(/\n+/g, ' ').slice(0, 30),
      aria: await b.getAttribute('aria-label').catch(() => null),
      title: await b.getAttribute('title').catch(() => null),
      dis: await b.isDisabled().catch(() => null),
    });
  }
  log(`${tag}-BTNS`, out);
  log(`${tag}-DRAGGABLE`, await scope.locator('[draggable=true]').count());
}

test('e15b slash/setup reorder controls + inline validation', async ({ page }) => {
  test.setTimeout(280_000);
  await page.goto(`/users/sign_in?fakeUser=${encodeURIComponent(EMAIL)}`);
  await page.waitForURL(
    url => url.pathname === '/profile' || url.pathname.startsWith('/organizations/'),
    { timeout: 40_000 }
  );
  await page.goto('/cloud');
  await page.waitForTimeout(6000);
  const picker = page.getByRole('button', { name: /No profile|V5 KEEP/ }).last();
  await picker.click();
  await page.waitForTimeout(1500);
  await page.getByText('Manage profiles...', { exact: false }).first().click();
  await page.waitForTimeout(2500);
  const d = page.locator('[role=dialog]').last();

  // profile with 2 slash commands
  await d.getByText('LIVE SLASH2 1789837817461', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  log('E15B-SLASH-TAB', (await d.innerText()).replace(/\n{2,}/g, '\n').slice(0, 800));
  await dump(d, 'E15B-SLASH');
  await page.screenshot({ path: `${OUT}/e15b-slash-tab.png`, fullPage: false });

  // inline validation: open Add command, submit empty
  await d
    .getByRole('button', { name: /Add command/i })
    .first()
    .click();
  await page.waitForTimeout(1200);
  log('E15B-SLASH-FORM', (await d.innerText()).replace(/\n{2,}/g, '\n').slice(-700));
  await dump(d, 'E15B-SLASH-FORM');
  const formInputs = await d.locator('input, textarea').all();
  for (let i = 0; i < formInputs.length; i++) {
    log(`E15B-SLASH-FORM-FIELD-${i}`, {
      tag: await formInputs[i].evaluate(el => el.tagName).catch(() => '?'),
      ph: await formInputs[i].getAttribute('placeholder'),
      name: await formInputs[i].getAttribute('name'),
      value: await formInputs[i].inputValue().catch(() => null),
    });
  }
  const save = d.getByRole('button', { name: /^Save$|^Create$|^Add$/ }).last();
  log('E15B-SAVE-EXISTS', await save.count());
  if (await save.count()) {
    await save.click({ force: true });
    await page.waitForTimeout(1500);
  }
  log('E15B-SLASH-VALIDATION', (await d.innerText()).replace(/\n{2,}/g, '\n').slice(-700));
  await page.screenshot({ path: `${OUT}/e15b-slash-inline-validation.png`, fullPage: false });
  // close the form without saving
  await d
    .getByRole('button', { name: /^Cancel$/ })
    .last()
    .click()
    .catch(() => {});
  await page.waitForTimeout(800);

  // setup tab with 2 commands
  await d.getByText('V5 KEEP 1789830500', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await d
    .getByRole('button', { name: /^Setup/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  log('E15B-SETUP-TAB', (await d.innerText()).replace(/\n{2,}/g, '\n').slice(0, 900));
  await dump(d, 'E15B-SETUP');
  await page.screenshot({ path: `${OUT}/e15b-setup-tab.png`, fullPage: false });
});
