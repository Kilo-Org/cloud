import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';
const EMAIL = 'v5-verify-1789830288@example.com';

function log(label: string, value: unknown) {
  console.log(`### ${label} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
}

test('e15i slash field value + validation detail', async ({ page }) => {
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
  await d.getByText('LIVE SLASH2 1789837817461', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await d
    .getByRole('button', { name: /^Slash Cmds/ })
    .first()
    .click();
  await page.waitForTimeout(1200);
  await d
    .getByRole('button', { name: /Add command/i })
    .first()
    .click();
  await page.waitForTimeout(1200);
  const name = d.locator('input[placeholder="my-command"]');
  const submit = d.getByRole('button', { name: /^Add command$/ }).last();
  const helper = async () =>
    d.evaluate(el => {
      const i = Array.from(el.querySelectorAll('input')).find(x => x.placeholder === 'my-command');
      const wrap = i?.closest('div');
      return {
        value: (i as HTMLInputElement)?.value ?? null,
        wrapText: (wrap?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      };
    });

  await name.fill('Bad Name!');
  await page.waitForTimeout(900);
  log('E15I-BAD-VALUE', await helper());
  log('E15I-BAD-SUBMIT-DISABLED', await submit.isDisabled());
  await submit.click({ force: true });
  await page.waitForTimeout(1500);
  log('E15I-BAD-AFTER-SUBMIT', await helper());
  const body = await d.innerText();
  log(
    'E15I-BAD-ERROR-TEXT',
    (
      body.match(
        /[^\n]*(invalid|already|exists|duplicate|conflict|must start|lowercase)[^\n]*/gi
      ) ?? []
    ).slice(0, 6)
  );
  log('E15I-BAD-FORM-OPEN', body.includes('Description (optional)'));
  await page.screenshot({ path: `${OUT}/e15i-bad-name.png`, fullPage: false });

  await name.fill('cmd-one');
  await page.waitForTimeout(900);
  log('E15I-DUP-VALUE', await helper());
  log('E15I-DUP-SUBMIT-DISABLED', await submit.isDisabled());
  await submit.click({ force: true });
  await page.waitForTimeout(1500);
  log('E15I-DUP-AFTER-SUBMIT', await helper());
  log(
    'E15I-DUP-TOASTS',
    (
      await page
        .locator('[data-sonner-toast]')
        .allInnerTexts()
        .catch(() => [] as string[])
    ).map(s => s.replace(/\n+/g, ' | ').slice(0, 200))
  );
  const body2 = await d.innerText();
  log(
    'E15I-DUP-ERROR-TEXT',
    (
      body2.match(
        /[^\n]*(invalid|already|exists|duplicate|conflict|must start|lowercase)[^\n]*/gi
      ) ?? []
    ).slice(0, 6)
  );
  log('E15I-DUP-FORM-OPEN', body2.includes('Description (optional)'));
  await page.screenshot({ path: `${OUT}/e15i-dup-name.png`, fullPage: false });
});
