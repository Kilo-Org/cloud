import { test } from '@playwright/test';

const OUT = process.env.KWF_OUT ?? '.';

function log(label: string, value: unknown) {
  console.log(
    `### ${label} ${typeof value === 'string' ? value.replace(/\n{2,}/g, '\n') : JSON.stringify(value)}`
  );
}

test('e18 locale probe', async ({ browser }) => {
  test.setTimeout(150_000);
  const ctx = await browser.newContext({
    locale: 'de-DE',
    extraHTTPHeaders: { 'Accept-Language': 'de-DE,de;q=0.9' },
  });
  const page = await ctx.newPage();
  const email = `kwf-locale-${Date.now()}@example.com`;
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
    await page.waitForTimeout(2000);
  }

  await page.goto('/cloud');
  await page.waitForTimeout(4000);
  log('E18-HTML-LANG', await page.evaluate(() => document.documentElement.lang));
  log('E18-COOKIES', (await ctx.cookies()).map(c => c.name).join(','));
  const body = await page.locator('body').innerText();
  log('E18-DE-WORDS', {
    profil: /Profil/.test(body),
    sprache: /Sprache|Deutsch/.test(body),
    umgebung: /Umgebung/.test(body),
    vars: /vars/.test(body),
    cmds: /cmds/.test(body),
    germanWords: (body.match(/\b(Profil|Umgebung|Sitzung|Einstellung|Sprache)\b/g) ?? []).slice(
      0,
      10
    ),
  });
  await page.screenshot({ path: `${OUT}/e18-probe-de-context.png`, fullPage: false });

  // try a NEXT_LOCALE cookie
  await ctx.addCookies([{ name: 'NEXT_LOCALE', value: 'de', domain: 'localhost', path: '/' }]);
  await page.reload();
  await page.waitForTimeout(4000);
  const body2 = await page.locator('body').innerText();
  log('E18-AFTER-NEXT-LOCALE-COOKIE', {
    htmlLang: await page.evaluate(() => document.documentElement.lang),
    profil: /Profil/.test(body2),
    vars: /vars/.test(body2),
    cmds: /cmds/.test(body2),
    germanWords: (body2.match(/\b(Profil|Umgebung|Sitzung|Einstellung|Sprache)\b/g) ?? []).slice(
      0,
      10
    ),
  });

  // look for any language switcher control on the page
  const sw = await page
    .getByRole('combobox')
    .allInnerTexts()
    .catch(() => [] as string[]);
  log(
    'E18-COMBOBOXES',
    sw.map(t => t.replace(/\n+/g, ' | ').slice(0, 120))
  );
  await page.screenshot({ path: `${OUT}/e18-probe-cookie.png`, fullPage: false });
  await ctx.close();
});
