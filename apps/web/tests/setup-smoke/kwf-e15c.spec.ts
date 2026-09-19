import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';

function log(label: string, value: unknown) {
  const s = typeof value === 'string' ? value.replace(/\n{2,}/g, '\n') : JSON.stringify(value);
  console.log(`### ${label} ${s}`);
}

async function ariaLabels(scope: import('@playwright/test').Locator) {
  const els = await scope.locator('button, [role=button]').all();
  const out: string[] = [];
  for (const b of els) {
    const aria = await b.getAttribute('aria-label').catch(() => null);
    const title = await b.getAttribute('title').catch(() => null);
    const t = (await b.innerText().catch(() => '')).replace(/\n+/g, ' ').trim().slice(0, 24);
    out.push([aria, title, t].filter(Boolean).join('/'));
  }
  return out;
}

test('e15c slash + setup reorder controls and inline validation', async ({ page }) => {
  test.setTimeout(280_000);
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

  // ---- Slash commands with 2 rows ----
  await d.getByText('LIVE SLASH2 1789837817461', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  log('E15C-SLASH-CONTROLS', await ariaLabels(d));
  log('E15C-SLASH-MOVE-ELEMENTS', await d.locator('text=/move|reorder/i').count());
  // hover a row then re-list
  await d
    .getByText('/cmd-one', { exact: false })
    .first()
    .hover()
    .catch(() => {});
  await page.waitForTimeout(800);
  log('E15C-SLASH-CONTROLS-HOVER', await ariaLabels(d));
  await page.screenshot({ path: `${OUT}/e15c-slash-controls.png`, fullPage: false });

  // inline validation: submit the add form with an empty name
  await d
    .getByRole('button', { name: /Add command/i })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await d
    .getByRole('button', { name: /^Add command$/ })
    .last()
    .click();
  await page.waitForTimeout(1500);
  const formText = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15C-SLASH-EMPTY-SUBMIT', formText.slice(formText.indexOf('Name')));
  await page.screenshot({ path: `${OUT}/e15c-slash-empty-validation.png`, fullPage: false });
  // invalid name
  await d.locator('input').first().fill('Bad Name!');
  await d
    .getByRole('button', { name: /^Add command$/ })
    .last()
    .click();
  await page.waitForTimeout(1200);
  const t2 = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15C-SLASH-INVALID-SUBMIT', t2.slice(t2.indexOf('Name')));
  await page.screenshot({ path: `${OUT}/e15c-slash-invalid-validation.png`, fullPage: false });
  // valid name -> add
  const name = `kwf-cmd-${Date.now()}`;
  await d.locator('input').first().fill(name);
  await d.locator('textarea').first().fill('do the thing');
  await d
    .getByRole('button', { name: /^Add command$/ })
    .last()
    .click();
  await page.waitForTimeout(2500);
  const afterAdd = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15C-SLASH-ADDED', afterAdd.includes(name));
  log('E15C-SLASH-AFTER-ADD-TAIL', afterAdd.slice(afterAdd.indexOf('Slash Cmds')));
  await page.screenshot({ path: `${OUT}/e15c-slash-added.png`, fullPage: false });

  // edit + delete the added row
  const row = d.getByText(`/${name}`, { exact: false }).first();
  await row.hover().catch(() => {});
  await page.waitForTimeout(600);
  await d.getByRole('button', { name: 'Edit command' }).last().click();
  await page.waitForTimeout(1200);
  const editText = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15C-SLASH-EDIT-FORM', editText.slice(editText.lastIndexOf('Name')));
  await d.locator('input').nth(1).fill('edited desc');
  await d
    .getByRole('button', { name: /^Save changes$|^Save$|^Update$/ })
    .last()
    .click()
    .catch(async () => {
      await d
        .getByRole('button', { name: /Add command/i })
        .last()
        .click();
    });
  await page.waitForTimeout(2500);
  const afterEdit = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15C-SLASH-EDITED', afterEdit.includes('edited desc'));
  await page.screenshot({ path: `${OUT}/e15c-slash-edited.png`, fullPage: false });
  // delete it
  const delBtns = await d
    .locator('button[aria-label="Delete command"], button:has(svg.lucide-trash-2)')
    .all();
  log('E15C-SLASH-DELETE-BTNS', delBtns.length);
  if (delBtns.length) {
    await delBtns[delBtns.length - 1].click();
    await page.waitForTimeout(1200);
    const confirmText = (await d.innerText()).replace(/\n{2,}/g, '\n');
    log('E15C-SLASH-DELETE-CONFIRM', /Confirm|Delete command\?|Remove/.test(confirmText));
    const confirm = d.getByRole('button', { name: /^Confirm$|^Delete$|^Remove$/ }).last();
    if (await confirm.count()) {
      await confirm.click();
      await page.waitForTimeout(2500);
    }
    const afterDel = (await d.innerText()).replace(/\n{2,}/g, '\n');
    log('E15C-SLASH-DELETED', !afterDel.includes(name));
    await page.screenshot({ path: `${OUT}/e15c-slash-deleted.png`, fullPage: false });
  }

  // ---- Setup commands with 2 rows ----
  await d.getByText('V5 KEEP 1789830500', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await d
    .getByRole('button', { name: /^Setup/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  log('E15C-SETUP-CONTROLS', await ariaLabels(d));
  const setupText = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15C-SETUP-TAB', setupText.slice(setupText.indexOf('Setup Commands')));
  await page.screenshot({ path: `${OUT}/e15c-setup-controls.png`, fullPage: false });

  // move the second setup command up
  const upBtns = await d.locator('button[aria-label*="up" i], button[aria-label*="Move" i]').all();
  log('E15C-SETUP-MOVE-BTNS', upBtns.length);
  if (upBtns.length) {
    const orderBefore = (await d.innerText()).replace(/\n{2,}/g, '\n');
    await upBtns[upBtns.length - 1].click();
    await page.waitForTimeout(2000);
    const orderAfter = (await d.innerText()).replace(/\n{2,}/g, '\n');
    log(
      'E15C-SETUP-ORDER-BEFORE',
      orderBefore.slice(orderBefore.indexOf('Setup Commands')).slice(0, 120)
    );
    log(
      'E15C-SETUP-ORDER-AFTER',
      orderAfter.slice(orderAfter.indexOf('Setup Commands')).slice(0, 120)
    );
    log('E15C-SETUP-ORDER-CHANGED', orderBefore !== orderAfter);
    await page.screenshot({ path: `${OUT}/e15c-setup-reordered.png`, fullPage: false });
  }
});
