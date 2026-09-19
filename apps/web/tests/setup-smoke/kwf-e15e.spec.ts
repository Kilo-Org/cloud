import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';

function log(label: string, value: unknown) {
  console.log(`### ${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

async function rowControls(scope: import('@playwright/test').Locator, tag: string) {
  const info = await scope.evaluate(el => {
    const btns = Array.from(el.querySelectorAll('button'));
    return btns.map(b => {
      const svg = b.querySelector('svg');
      return {
        t: (b.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 20),
        aria: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
        icon: svg
          ? (svg.getAttribute('class') ?? '')
              .split(' ')
              .filter(c => c.startsWith('lucide'))
              .join('.')
          : null,
        dis: (b as HTMLButtonElement).disabled,
      };
    });
  });
  log(`${tag}-BUTTONS`, info);
}

test('e15e reorder controls identification', async ({ page }) => {
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

  // Setup tab (2 commands)
  await d.getByText('V5 KEEP 1789830500', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await d
    .getByRole('button', { name: /^Setup/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await rowControls(d, 'E15E-SETUP');
  const before = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log('E15E-SETUP-BEFORE', before.slice(before.indexOf('Setup Commands')).slice(0, 120));

  // click every unlabeled button one at a time, in reverse, and report the effect
  for (let pass = 0; pass < 4; pass++) {
    const btns = await d.locator('button').all();
    let clicked = false;
    for (let i = 0; i < btns.length; i++) {
      const aria = await btns[i].getAttribute('aria-label').catch(() => null);
      const t = (await btns[i].innerText().catch(() => '')).trim();
      if (aria || t) continue;
      const dis = await btns[i].isDisabled().catch(() => true);
      if (dis) continue;
      const idx = await btns[i].evaluate(el =>
        Array.from(el.closest('[role=dialog]')!.querySelectorAll('button')).indexOf(
          el as HTMLButtonElement
        )
      );
      await btns[i].click({ force: true }).catch(() => {});
      await page.waitForTimeout(1800);
      const now = (await d.innerText()).replace(/\n{2,}/g, '\n');
      const toast = await page
        .locator('[data-sonner-toast]')
        .allInnerTexts()
        .catch(() => [] as string[]);
      log(`E15E-SETUP-CLICK-${pass}-${i}`, {
        btnIndex: idx,
        setupAfter: now.slice(now.indexOf('Setup Commands')).slice(0, 120),
        changed: now !== before,
        toast: toast.map(s => s.replace(/\n+/g, ' ').slice(0, 120)),
      });
      clicked = true;
      break;
    }
    if (!clicked) break;
  }
  await page.screenshot({ path: `${OUT}/e15e-setup-after-clicks.png`, fullPage: false });
});
