import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';
const EMPTY_PROFILE = 'LIVE SLASH 1789837725014';
const SLASH_PROFILE = 'LIVE SLASH2 1789837817461';
const SETUP_PROFILE = 'LIVE EMPTY 1789837493205';

function log(label: string, value: unknown) {
  const s = typeof value === 'string' ? value.replace(/\n{2,}/g, '\n') : JSON.stringify(value);
  console.log(`### ${label} ${s}`);
}

async function btnDump(scope: import('@playwright/test').Locator) {
  return scope.evaluate(el =>
    Array.from(el.querySelectorAll('button')).map(b => {
      const svg = b.querySelector('svg');
      return {
        t: (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
        aria: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
        icon: svg
          ? (svg.getAttribute('class') ?? '')
              .split(' ')
              .filter(x => x.startsWith('lucide'))
              .join('.')
          : null,
      };
    })
  );
}

async function reorderScan(scope: import('@playwright/test').Locator, tag: string) {
  const n = await scope
    .locator(
      'button[aria-label*="up" i], button[aria-label*="down" i], button[aria-label*="move" i], button[title*="up" i], button[title*="move" i], [aria-roledescription], [draggable=true]'
    )
    .count();
  log(`${tag}-REORDER-CONTROLS`, n);
  log(`${tag}-DRAGGABLE`, await scope.locator('[draggable=true]').count());
  const txt = (await scope.innerText()).replace(/\n{2,}/g, '\n');
  log(
    `${tag}-MOVE-WORDS`,
    ['Move up', 'Move down', 'Reorder', 'reorder'].filter(w => txt.includes(w))
  );
}

test('e15v manage-profiles tabs: empty, add/edit/delete, inline validation, reorder scan', async ({
  page,
}) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(8000);
  await page.goto(`/users/sign_in?fakeUser=${encodeURIComponent(EMAIL)}`);
  await page.waitForURL(
    url => url.pathname === '/profile' || url.pathname.startsWith('/organizations/'),
    {
      timeout: 40_000,
    }
  );
  await page.goto('/cloud');
  await page.waitForTimeout(5000);
  await page
    .getByRole('button', { name: /No profile|V5 KEEP/ })
    .last()
    .click();
  await page.waitForTimeout(1200);
  await page.getByText('Manage profiles...', { exact: false }).first().click();
  await page.waitForTimeout(2000);
  const d = page.locator('[role=dialog]').last();

  // ---- empty states on every tab ----
  await d.getByText(EMPTY_PROFILE, { exact: true }).first().click();
  await page.waitForTimeout(1000);
  const tabs: Array<[string, RegExp]> = [
    ['Variables', /^Variables/],
    ['Setup', /^Setup/],
    ['SlashCmds', /^Slash Cmds/],
    ['MCP', /^MCP/],
    ['Skills', /^Skills/],
    ['Agents', /^Agents/],
  ];
  for (const [name, re] of tabs) {
    await d.getByRole('button', { name: re }).first().click();
    await page.waitForTimeout(700);
    const txt = (await d.innerText()).replace(/\n{2,}/g, '\n');
    log(`E15V-EMPTY-${name}`, txt.slice(-220));
    await page.screenshot({ path: `${OUT}/e15v-empty-${name.toLowerCase()}.png`, fullPage: false });
  }

  // ---- slash: list + reorder scan on a profile with 3 commands ----
  await d.getByText(SLASH_PROFILE, { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(900);
  const slashTxt = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15V-SLASH-TAB', slashTxt.slice(slashTxt.indexOf('Slash Cmds')));
  log('E15V-SLASH-BTNS', await btnDump(d));
  await reorderScan(d, 'E15V-SLASH');
  await page.screenshot({ path: `${OUT}/e15v-slash-list.png`, fullPage: false });

  // ---- slash add form: empty + invalid + valid ----
  await d
    .getByRole('button', { name: /Add command/i })
    .first()
    .click();
  await page.waitForTimeout(900);
  const addBtn = d.getByRole('button', { name: /^Add command$/ }).last();
  await addBtn.click().catch(() => {});
  await page.waitForTimeout(1200);
  const emptyTxt = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15V-SLASH-EMPTY-SUBMIT', emptyTxt.slice(emptyTxt.lastIndexOf('Name')).slice(0, 180));
  await page.screenshot({ path: `${OUT}/e15v-slash-empty-validation.png`, fullPage: false });

  await d.locator('input').first().fill('Bad Name!');
  await addBtn.click().catch(() => {});
  await page.waitForTimeout(1000);
  const invTxt = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15V-SLASH-INVALID-SUBMIT', invTxt.slice(invTxt.lastIndexOf('Name')).slice(0, 180));
  await page.screenshot({ path: `${OUT}/e15v-slash-invalid-validation.png`, fullPage: false });

  const nm = `kwfv-${Date.now()}`;
  await d.locator('input').first().fill(nm);
  await d.locator('textarea').first().fill('do the thing');
  await addBtn.click().catch(() => {});
  await page.waitForTimeout(2200);
  log('E15V-SLASH-ADDED', (await d.innerText()).includes(nm));
  await page.screenshot({ path: `${OUT}/e15v-slash-added.png`, fullPage: false });

  // edit it
  await d
    .getByText(`/${nm}`, { exact: false })
    .first()
    .hover()
    .catch(() => {});
  await page.waitForTimeout(500);
  await d
    .getByRole('button', { name: 'Edit command' })
    .last()
    .click()
    .catch(() => {});
  await page.waitForTimeout(1000);
  await d
    .locator('input')
    .nth(1)
    .fill('edited desc')
    .catch(() => {});
  await d
    .getByRole('button', { name: /^Save changes$|^Save$|^Update$/ })
    .last()
    .click()
    .catch(() => {});
  await page.waitForTimeout(2200);
  log('E15V-SLASH-EDITED', (await d.innerText()).includes('edited desc'));
  await page.screenshot({ path: `${OUT}/e15v-slash-edited.png`, fullPage: false });

  // delete it
  const delBtns = await d.locator('button:has(svg.lucide-trash-2)').all();
  log('E15V-SLASH-DELETE-BTNS', delBtns.length);
  if (delBtns.length) {
    await delBtns[delBtns.length - 1].click().catch(() => {});
    await page.waitForTimeout(1000);
    const confirm = d.getByRole('button', { name: /^Confirm$|^Delete$|^Remove$/ }).last();
    await confirm.click().catch(() => {});
    await page.waitForTimeout(2200);
  }
  log('E15V-SLASH-DELETED', !(await d.innerText()).includes(nm));
  await page.screenshot({ path: `${OUT}/e15v-slash-deleted.png`, fullPage: false });

  // ---- MCP / Skills / Agents: Add action opens a form ----
  for (const [name, re, add] of [
    ['MCP', /^MCP/, /Add MCP server/i],
    ['Skills', /^Skills/, /Add skill manually/i],
    ['Agents', /^Agents/, /Add agent/i],
  ] as Array<[string, RegExp, RegExp]>) {
    await d.getByRole('button', { name: re }).first().click();
    await page.waitForTimeout(700);
    const addBtn2 = d.getByRole('button', { name: add }).first();
    const exists = await addBtn2.count();
    log(`E15V-${name}-ADD-ACTION`, exists > 0);
    if (exists) {
      await addBtn2.click().catch(() => {});
      await page.waitForTimeout(1000);
      const t = (await d.innerText()).replace(/\n{2,}/g, '\n');
      log(`E15V-${name}-FORM-OPEN`, /Name|Key|URL|Command|Description|Template/.test(t));
      await page.screenshot({
        path: `${OUT}/e15v-${name.toLowerCase()}-form.png`,
        fullPage: false,
      });
      await d
        .getByRole('button', { name: /^Cancel$|^Close$/ })
        .last()
        .click()
        .catch(() => {});
      await page.waitForTimeout(700);
    }
  }

  // ---- setup: reorder scan on a profile with 2 commands ----
  await d.getByText(SETUP_PROFILE, { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await d
    .getByRole('button', { name: /^Setup/ })
    .first()
    .click();
  await page.waitForTimeout(900);
  const setupTxt = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15V-SETUP-TAB', setupTxt.slice(setupTxt.indexOf('Setup Commands')));
  log('E15V-SETUP-BTNS', await btnDump(d));
  await reorderScan(d, 'E15V-SETUP');
  await page.screenshot({ path: `${OUT}/e15v-setup-list.png`, fullPage: false });
});
