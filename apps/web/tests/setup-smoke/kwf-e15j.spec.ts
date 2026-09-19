import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';

function log(label: string, value: unknown) {
  console.log(`### ${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function scan(scope: import('@playwright/test').Locator, tag: string) {
  const r = await scope.evaluate(el => {
    const hits: string[] = [];
    for (const n of Array.from(el.querySelectorAll('*'))) {
      const hay =
        `${n.getAttribute('class') ?? ''} ${n.getAttribute('aria-label') ?? ''} ${n.getAttribute('title') ?? ''} ${n.getAttribute('data-testid') ?? ''}`.toLowerCase();
      if (/arrow|chevron-up|chevron-down|move|reorder|grip|drag/.test(hay)) {
        hits.push(
          `${n.tagName}:${(n.getAttribute('class') ?? '').slice(0, 60)}|${n.getAttribute('aria-label')}|${n.getAttribute('title')}`
        );
      }
    }
    return Array.from(new Set(hits)).slice(0, 10);
  });
  log(`${tag}-SCAN`, r);
  log(`${tag}-DRAGGABLE`, await scope.locator('[draggable=true]').count());
}

test('e15j focus scan for reorder controls', async ({ page }) => {
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
  await d
    .getByText('echo one', { exact: true })
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(800);
  await scan(d, 'E15J-SETUP-FOCUSED');

  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await d
    .getByText('/cmd-one', { exact: false })
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(800);
  await scan(d, 'E15J-SLASH-FOCUSED');
  // also try keyboard: focus first command row and press ArrowDown
  await page.keyboard.press('Tab');
  await page.waitForTimeout(400);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(1200);
  const t = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15J-SLASH-AFTER-ARROWKEY', t.slice(t.indexOf('Slash Cmds')).slice(0, 140));
  await page.screenshot({ path: `${OUT}/e15j-focused-scan.png`, fullPage: false });
});
