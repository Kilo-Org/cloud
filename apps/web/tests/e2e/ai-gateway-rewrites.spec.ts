import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('starts the standalone gateway with the Playwright servers', async ({ request, baseURL }) => {
  if (!baseURL) throw new Error('Playwright baseURL is required');
  const gatewayPort = process.env.AI_GATEWAY_PORT || Number(new URL(baseURL).port) + 10;
  const response = await request.post(`http://localhost:${gatewayPort}/api/v1/fim/completions`, {
    data: {},
  });

  expect(response.status()).toBe(401);
  expect(response.headers()['content-type']).toContain('application/json');
});

for (const path of ['/api/fim/completions', '/api/edit/completions']) {
  test(`proxies ${path} to the gateway`, async ({ request }) => {
    const response = await request.post(path, { data: {} });

    expect(response.status()).toBe(401);
    expect(response.headers()['content-type']).toContain('application/json');
  });
}

test('proxies organization model requests without changing authentication', async ({ request }) => {
  const response = await request.get('/api/organizations/playwright/models');

  expect(response.status()).toBe(401);
  expect(response.headers()['content-type']).toContain('application/json');
});

test('serves a gateway response to browser requests through the web app', async ({ page }) => {
  await page.goto('/users/sign_in');
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/fim/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return response.status;
  });

  expect(status).toBe(401);
});
