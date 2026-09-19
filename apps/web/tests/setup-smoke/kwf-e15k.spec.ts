import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';

function log(label: string, value: unknown) {
  console.log(`### ${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function scan(scope: import('@playwright/test').Locator, tag: string) {
  const info = await scope.evaluate(el => {
    const btns = Array.from(el.querySelectorAll('button')).map(b => {
      const svg = b.querySelector('svg');
      return {
        t: (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
        aria: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
        roleDesc: b.getAttribute('aria-roledescription'),
        icon: svg
          ? (svg.getAttribute('class') ?? '')
              .split(' ')
              .filter(c => c.startsWith('lucide'))
              .join('.')
          : null,
      };
    });
    const sortable = Array.from(
      el.querySelectorAll(
        '[aria-roledescription], [class*=sortable], [class*=dnd], [class*=drag], [class*=grip], [class*=handle], [draggable=true]'
      )
    )
      .map(n => ({
        tag: n.tagName,
        cls: (n.getAttribute('class') ?? '').slice(0, 120),
        roleDesc: n.getAttribute('aria-roledescription'),
        drag: n.getAttribute('draggable'),
      }))
      .slice(0, 30);
    const text = el.textContent ?? '';
    const moveWords = ['Move up', 'Move down', 'move up', 'move down', 'Reorder', 'reorder'].filter(
      w => text.includes(w)
    );
    return { btns, sortable, moveWords };
  });
  log(`${tag}-BTNS`, info.btns);
  log(`${tag}-SORTABLE`, info.sortable);
  log(`${tag}-MOVE-WORDS`, info.moveWords);
}

test('e15k reorder affordance deep scan', async ({ page }) => {
  test.setTimeout(220_000);
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
  await page.waitForTimeout(1500);
  await scan(d, 'E15K-SETUP');
  const setupText = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15K-SETUP-TEXT', setupText.slice(setupText.indexOf('Setup Commands')).slice(0, 300));
  await page.screenshot({ path: `${OUT}/e15k-setup-tab.png`, fullPage: false });

  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(1500);
  await scan(d, 'E15K-SLASH');
  const slashText = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15K-SLASH-TEXT', slashText.slice(slashText.indexOf('Slash Cmds')).slice(0, 400));
  await page.screenshot({ path: `${OUT}/e15k-slash-tab.png`, fullPage: false });
});
