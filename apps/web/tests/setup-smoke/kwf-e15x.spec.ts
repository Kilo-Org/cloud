import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';
const EMPTY_PROFILE = 'LIVE SLASH 1789837725014';

function log(label: string, value: unknown) {
  const s = typeof value === 'string' ? value.replace(/\n{2,}/g, '\n') : JSON.stringify(value);
  console.log(`### ${label} ${s}`);
}

test('e15x skills manual add form', async ({ page }) => {
  test.setTimeout(160_000);
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
  await d.getByText(EMPTY_PROFILE, { exact: true }).first().click();
  await page.waitForTimeout(1000);
  await d
    .getByRole('button', { name: /^Skills/ })
    .first()
    .click();
  await page.waitForTimeout(800);
  await d
    .getByRole('button', { name: /Add skill manually/i })
    .first()
    .click();
  await page.waitForTimeout(1500);
  const t = (await d.innerText()).replace(/\n{2,}/g, '\n');
  log(
    'E15X-SKILLS-AFTER-ADD',
    t
      .slice(t.lastIndexOf('Add skill manually') > 0 ? t.lastIndexOf('Add skill manually') : 0)
      .slice(0, 400)
  );
  log(
    'E15X-SKILLS-FORM-FIELDS',
    await d.evaluate(el =>
      Array.from(el.querySelectorAll('input, textarea, button'))
        .map(
          n =>
            `${n.tagName}:${n.getAttribute('placeholder') ?? n.textContent?.replace(/\s+/g, ' ').trim().slice(0, 24) ?? ''}`
        )
        .slice(0, 30)
    )
  );
  await page.screenshot({ path: `${OUT}/e15x-skills-manual-form.png`, fullPage: false });
});
