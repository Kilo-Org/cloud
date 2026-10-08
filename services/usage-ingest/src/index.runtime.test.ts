import { createTestHarness } from 'wrangler';
import { expect, it } from 'vitest';

it('starts the configured Worker entry in workerd', async () => {
  const server = createTestHarness({
    workers: [
      {
        configPath: new URL('../wrangler.jsonc', import.meta.url),
        secrets: { USAGE_INGEST_PUBLISH_SECRET: 'synthetic-local-secret' },
      },
    ],
  });
  try {
    const { url } = await server.listen();
    const response = await fetch(new URL('/usage', url));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect((await fetch(new URL('/usage', url), { method: 'POST' })).status).toBe(401);
  } finally {
    await server.close();
  }
}, 20_000);
