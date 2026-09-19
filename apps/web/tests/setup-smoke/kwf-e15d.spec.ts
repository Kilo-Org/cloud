import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';

function log(label: string, value: unknown) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`### ${label} ${s}`);
}

async function controls(scope: import('@playwright/test').Locator, tag: string) {
  const els = await scope.locator('button, [role=button]').all();
  const out: unknown[] = [];
  for (const b of els) {
    out.push({
      t: (await b.innerText().catch(() => '')).replace(/\n+/g, ' ').trim().slice(0, 24),
      aria: await b.getAttribute('aria-label').catch(() => null),
      title: await b.getAttribute('title').catch(() => null),
      svg: await b
        .locator('svg')
        .first()
        .getAttribute('class')
        .then(c =>
          (c ?? '')
            .split(' ')
            .filter(x => x.startsWith('lucide'))
            .join(' ')
        )
        .catch(() => null),
    });
  }
  log(`${tag}-CONTROLS`, out);
}

test('e15d reorder controls + MCP/Agents/Skills add', async ({ page }) => {
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

  // --- Setup tab: what are the unlabeled buttons? ---
  await d.getByText('V5 KEEP 1789830500', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await d
    .getByRole('button', { name: /^Setup/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await controls(d, 'E15D-SETUP');
  const rowHtml = await d.evaluate(el => {
    const txt = el.textContent ?? '';
    const idx = txt.indexOf('Setup Commands');
    const rows = Array.from(el.querySelectorAll('li, [class*="space-y"], [class*="rounded"]'));
    return rows
      .map(r => (r as HTMLElement).outerHTML)
      .filter(h => h.includes('echo'))
      .slice(0, 2)
      .join('\n---\n')
      .replace(/\s+/g, ' ')
      .slice(0, 1800);
  });
  log('E15D-SETUP-ROW-HTML', rowHtml);
  // click each unlabeled button in turn and see what changes
  const before = (await d.innerText()).replace(/\n{2,}/g, '\n');
  const setupSection = d.locator('[role=dialog]').last();
  void setupSection;
  const allBtns = await d.locator('button').all();
  for (let i = 0; i < allBtns.length; i++) {
    const aria = await allBtns[i].getAttribute('aria-label').catch(() => null);
    const t = (await allBtns[i].innerText().catch(() => '')).trim();
    if (aria || t) continue;
    await allBtns[i].click({ force: true }).catch(() => {});
    await page.waitForTimeout(1500);
    const now = (await d.innerText()).replace(/\n{2,}/g, '\n');
    const toast = await page
      .locator('[data-sonner-toast]')
      .allInnerTexts()
      .catch(() => [] as string[]);
    log(`E15D-UNLABELED-${i}`, {
      changed: now !== before,
      toast: toast.map(s => s.replace(/\n+/g, ' ').slice(0, 160)),
      setup: now.slice(now.indexOf('Setup Commands')).slice(0, 140),
    });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(600);
    break;
  }
  await page.screenshot({ path: `${OUT}/e15d-setup-controls.png`, fullPage: false });

  // --- MCP tab add/edit/delete ---
  await d.getByRole('button', { name: /^MCP/ }).first().click();
  await page.waitForTimeout(1200);
  await d
    .getByRole('button', { name: /Add MCP server/i })
    .first()
    .click();
  await page.waitForTimeout(1500);
  const mcpForm = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log(
    'E15D-MCP-FORM',
    mcpForm.slice(mcpForm.lastIndexOf('Add MCP') > 0 ? mcpForm.length - 800 : 0)
  );
  const mcpInputs = await d.locator('input, textarea').all();
  for (let i = 0; i < mcpInputs.length; i++) {
    log(`E15D-MCP-FIELD-${i}`, {
      tag: await mcpInputs[i].evaluate(el => el.tagName),
      ph: await mcpInputs[i].getAttribute('placeholder'),
    });
  }
  await page.screenshot({ path: `${OUT}/e15d-mcp-form.png`, fullPage: false });
  // submit empty -> inline validation
  const mcpSave = d
    .getByRole('button', { name: /^Add server$|^Save changes$|^Save$|^Add$/ })
    .last();
  if (await mcpSave.count()) {
    await mcpSave.click({ force: true });
    await page.waitForTimeout(1500);
    const v = (await d.innerText()).replace(/\n{2,}/g, '\n');
    log('E15D-MCP-VALIDATION', v.slice(Math.max(0, v.length - 600)));
    await page.screenshot({ path: `${OUT}/e15d-mcp-validation.png`, fullPage: false });
  }
  const mcpName = `kwf-mcp-${Date.now()}`;
  await mcpInputs[0].fill(mcpName);
  if (mcpInputs.length > 1) await mcpInputs[1].fill('npx -y some-mcp');
  if (await mcpSave.count()) {
    await mcpSave.click({ force: true });
    await page.waitForTimeout(2500);
  }
  const afterMcp = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15D-MCP-ADDED', afterMcp.includes(mcpName));
  await page.screenshot({ path: `${OUT}/e15d-mcp-added.png`, fullPage: false });

  // --- Agents tab add ---
  await d
    .getByRole('button', { name: /^Agents/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await d
    .getByRole('button', { name: /Add agent/i })
    .first()
    .click();
  await page.waitForTimeout(1500);
  const agentForm = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15D-AGENT-FORM', agentForm.slice(Math.max(0, agentForm.length - 700)));
  const agentInputs = await d.locator('input, textarea').all();
  for (let i = 0; i < agentInputs.length; i++) {
    log(`E15D-AGENT-FIELD-${i}`, {
      tag: await agentInputs[i].evaluate(el => el.tagName),
      ph: await agentInputs[i].getAttribute('placeholder'),
    });
  }
  const agentSave = d
    .getByRole('button', { name: /^Add agent$|^Save changes$|^Save$|^Add$/ })
    .last();
  if (await agentSave.count()) {
    await agentSave.click({ force: true });
    await page.waitForTimeout(1500);
    const v = (await d.innerText()).replace(/\n{2,}/g, '\n');
    log('E15D-AGENT-VALIDATION', v.slice(Math.max(0, v.length - 600)));
    await page.screenshot({ path: `${OUT}/e15d-agent-validation.png`, fullPage: false });
  }
  const agentSlug = `kwf-agent-${Date.now()}`;
  await agentInputs[0].fill(agentSlug);
  if (agentInputs.length > 1) await agentInputs[1].fill('KWF Agent');
  if (await agentSave.count()) {
    await agentSave.click({ force: true });
    await page.waitForTimeout(2500);
  }
  const afterAgent = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15D-AGENT-ADDED', afterAgent.includes(agentSlug));
  await page.screenshot({ path: `${OUT}/e15d-agent-added.png`, fullPage: false });
});
