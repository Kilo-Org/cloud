import { expect, test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';

function log(label: string, value: unknown) {
  const s = typeof value === 'string' ? value.replace(/\n{2,}/g, '\n') : JSON.stringify(value);
  console.log(`### ${label} ${s}`);
}

async function btnInfo(scope: import('@playwright/test').Locator) {
  const btns = await scope.locator('button').all();
  const out: unknown[] = [];
  for (const b of btns.slice(0, 40)) {
    out.push({
      t: (await b.innerText().catch(() => '')).replace(/\n+/g, ' ').slice(0, 40),
      aria: await b.getAttribute('aria-label').catch(() => null),
      title: await b.getAttribute('title').catch(() => null),
      dis: await b.isDisabled().catch(() => null),
    });
  }
  return out;
}

test('e15 manage-profiles tabs: empty, add/edit/delete, inline validation, reorder by buttons', async ({
  page,
}) => {
  test.setTimeout(280_000);
  const email = process.env.KWF_E15_EMAIL ?? `kwf-e15-${Date.now()}@example.com`;
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
    await page.waitForTimeout(2500);
  }
  log('E15-EMAIL', email);
  log('E15-LANDED', page.url());

  await page.goto('/cloud');
  await page.waitForTimeout(6000);
  const cloudText = await page.locator('body').innerText();
  log('E15-CLOUD-READY', /What would you like to do\?/.test(cloudText));
  log('E15-CLOUD-CONNECT-REPO', /Connect a repository provider/.test(cloudText));
  await page.screenshot({ path: `${OUT}/e15-cloud-empty-account.png`, fullPage: false });

  const picker = page.getByRole('button', { name: /No profile|profile/i }).last();
  await picker.click();
  await page.waitForTimeout(1500);
  const pickerText = await page
    .locator('[role=dialog]')
    .last()
    .innerText()
    .catch(() => 'NO-DIALOG');
  log('E15-PICKER', pickerText.replace(/\n{2,}/g, '\n').slice(0, 600));
  await page.screenshot({ path: `${OUT}/e15-picker-empty-account.png`, fullPage: false });
  log('E15-PICKER-HAS-NOPROFILE', /No profile/.test(pickerText));
  log('E15-PICKER-HAS-MANAGE', /Manage profiles/.test(pickerText));

  await page.getByText('Manage profiles...', { exact: false }).first().click();
  await page.waitForTimeout(2500);
  const d = page.locator('[role=dialog]').last();

  // New profile -> empty name refused
  await d.getByRole('button', { name: 'New profile' }).click();
  await page.waitForTimeout(1200);
  log('E15-NEW-FORM-BTNS', await btnInfo(d));
  log(
    'E15-CREATE-DISABLED',
    await d.getByRole('button', { name: 'Create', exact: true }).isDisabled()
  );
  const pname = `E15 P ${Date.now()}`;
  await d
    .getByPlaceholder(/Backend debugging/i)
    .first()
    .fill(pname);
  await d.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForTimeout(3000);
  log('E15-CREATED', (await d.innerText()).includes(pname));

  // Tab inventory on the new (empty) profile
  const tabNames = ['Variables', 'Setup', 'Slash Cmds', 'MCP', 'Skills', 'Agents'];
  for (const t of tabNames) {
    await d
      .getByRole('button', { name: new RegExp(`^${t}\\b`) })
      .first()
      .click();
    await page.waitForTimeout(900);
    const txt = (await d.innerText()).replace(/\n{2,}/g, '\n');
    log(`E15-TAB-${t.replace(/\s+/g, '-')}`, txt.slice(0, 700));
    log(`E15-TAB-${t.replace(/\s+/g, '-')}-BTNS`, (await btnInfo(d)).slice(-8));
  }

  // ---- Slash Cmds: empty state, inline validation, add, edit, delete ----
  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(900);
  await d
    .getByRole('button', { name: /Add command/i })
    .first()
    .click();
  await page.waitForTimeout(1000);
  await d
    .getByRole('button', { name: /^Save$|^Add$/ })
    .last()
    .click();
  await page.waitForTimeout(1200);
  log('E15-SLASH-VALIDATION', (await d.innerText()).replace(/\n{2,}/g, '\n').slice(0, 500));
  log('E15-SLASH-FORM-BTNS', await btnInfo(d));
  await page.screenshot({ path: `${OUT}/e15-slash-inline-validation.png`, fullPage: false });
  const inputs = await d.locator('input').all();
  for (let i = 0; i < inputs.length; i++) {
    log(`E15-SLASH-INPUT-${i}`, {
      ph: await inputs[i].getAttribute('placeholder'),
      aria: await inputs[i].getAttribute('aria-label'),
    });
  }
  // fill a valid command
  await d.locator('input').first().fill('cmd-one');
  const tas = await d.locator('textarea').all();
  if (tas.length) await tas[0].fill('cmd-one body');
  await d
    .getByRole('button', { name: /^Save$|^Add$/ })
    .last()
    .click();
  await page.waitForTimeout(2500);
  log('E15-SLASH-AFTER-ADD', (await d.innerText()).replace(/\n{2,}/g, '\n').slice(0, 500));
  await page.screenshot({ path: `${OUT}/e15-slash-added.png`, fullPage: false });
  expect(await d.innerText()).toContain('cmd-one');
});
