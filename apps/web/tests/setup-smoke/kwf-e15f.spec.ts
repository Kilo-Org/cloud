import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';

function log(label: string, value: unknown) {
  console.log(`### ${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function arrowScan(scope: import('@playwright/test').Locator, tag: string) {
  const found = await scope.evaluate(el => {
    const out: string[] = [];
    for (const n of Array.from(el.querySelectorAll('*'))) {
      const cls = (n.getAttribute('class') ?? '').toLowerCase();
      const aria = (n.getAttribute('aria-label') ?? '').toLowerCase();
      const title = (n.getAttribute('title') ?? '').toLowerCase();
      const role = (n.getAttribute('role') ?? '').toLowerCase();
      const draggable = n.getAttribute('draggable');
      const hay = `${cls} ${aria} ${title} ${role}`;
      if (
        /arrow-up|arrow-down|chevron-up|chevron-down|move-up|move-down|reorder|grip|drag/.test(
          hay
        ) ||
        draggable === 'true'
      ) {
        out.push(
          `${n.tagName}.${(n.getAttribute('class') ?? '')
            .split(' ')
            .filter(c => c.startsWith('lucide'))
            .join(
              '.'
            )}|aria=${n.getAttribute('aria-label')}|title=${n.getAttribute('title')}|drag=${draggable}`
        );
      }
    }
    return Array.from(new Set(out)).slice(0, 20);
  });
  log(`${tag}-ARROW-OR-DRAG`, found);
  log(`${tag}-DRAGGABLE-COUNT`, await scope.locator('[draggable=true]').count());
}

test('e15f reorder affordance scan', async ({ page }) => {
  test.setTimeout(200_000);
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
  await d.getByText('V5 KEEP 1789830500', { exact: true }).first().click();
  await page.waitForTimeout(1500);

  await d
    .getByRole('button', { name: /^Setup/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await arrowScan(d, 'E15F-SETUP');

  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await arrowScan(d, 'E15F-SLASH');

  await d.getByRole('button', { name: /^MCP/ }).first().click();
  await page.waitForTimeout(1200);
  await arrowScan(d, 'E15F-MCP');

  await d
    .getByRole('button', { name: /^Skills/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await arrowScan(d, 'E15F-SKILLS');

  await d
    .getByRole('button', { name: /^Agents/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await arrowScan(d, 'E15F-AGENTS');
  await page.screenshot({ path: `${OUT}/e15f-agents-tab.png`, fullPage: false });
});
