import { env, reset, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('loads only declared test bindings without a database connection', () => {
  expect(env.ENVIRONMENT).toBe('test');
  expect(env.NEXTAUTH_SECRET).toBe('test-nextauth-secret');
  expect(env.INTERNAL_API_SECRET).toBe('test-internal-secret');
  expect(env.KILOCODE_BACKEND_BASE_URL).toBe('https://app.kilo.ai');
  expect(env.KILO_GATEWAY_URL).toBe('https://api.kilo.ai/api/openrouter');
  expect(env.HYPERDRIVE).toEqual({ connectionString: 'postgresql://[disabled-test-database' });
  expect(() => new URL(env.HYPERDRIVE.connectionString)).toThrow();
  expect(
    Object.keys(env)
      .filter(name => !name.startsWith('__'))
      .sort()
  ).toEqual([
    'ENVIRONMENT',
    'HYPERDRIVE',
    'INTERNAL_API_SECRET',
    'KILOCODE_BACKEND_BASE_URL',
    'KILO_GATEWAY_URL',
    'NEXTAUTH_SECRET',
    'REVIEW_ISOLATE',
  ]);
});

it('blocks native outbound HTTP before reaching any network fixture', async () => {
  const response = await fetch('http://127.0.0.1:1/isolate-test-outbound');
  expect(response.status).toBe(500);
  expect(await response.text()).toContain('Unexpected outbound request in isolate-review tests');
});

it('completes after logging from Durable Objects that are reset', async () => {
  for (let index = 0; index < 20; index++) {
    const stub = env.REVIEW_ISOLATE.getByName(`harness-${index}`);
    await runInDurableObject(stub, () => {
      console.log('isolate-review teardown fixture');
    });
    await reset();
  }
});
