const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const { localOrigin } = require('./metrics.cjs');
const { chromium } = createRequire(path.resolve(__dirname, '../../../apps/web/package.json'))(
  '@playwright/test'
);

async function login() {
  const baseUrl = localOrigin(process.env.BASE_URL ?? 'http://localhost:3000');
  if (!process.env.EMAIL) throw new Error('Set EMAIL to the local fixture user');
  const output = process.env.STORAGE_STATE ?? '/tmp/kilo2/cloud-navigation-auth.json';
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const query = new URLSearchParams({ fakeUser: process.env.EMAIL, callbackPath: '/cloud' });
    await page.goto(`${baseUrl}/users/sign_in?${query}`);
    await page.waitForURL(url => url.pathname.startsWith('/cloud'), { timeout: 120000 });
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(await page.context().storageState()), {
      mode: 0o600,
    });
    await fs.chmod(output, 0o600);
    console.log(`Saved local browser authentication to ${output}`);
  } finally {
    await browser.close();
  }
}

login().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
