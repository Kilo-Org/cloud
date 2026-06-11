import { SELF, env, reset } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

const PRIVATE_WORKER_NAME = 'qdpl-runtime-regression';
const PERSISTENT_WORKER_NAME = 'dpl-persistent-worker';
const FRIENDLY_SLUG = 'bright-fern-4821';

afterEach(async () => {
  await reset();
});

describe('dispatcher production entrypoint Workers-runtime boundary', () => {
  it('preserves a mapped legacy qdpl-prefixed persistent alias', async () => {
    const legacySlug = 'qdpl-legacy-alias';
    await env.DEPLOY_KV.put(`slug2worker:${legacySlug}`, PERSISTENT_WORKER_NAME);
    await env.DEPLOY_KV.put(`worker2slug:${PERSISTENT_WORKER_NAME}`, legacySlug);

    const response = await SELF.fetch(`https://${legacySlug}.d.kiloapps.io/runtime-check`);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(
      `fake internal worker served ${PERSISTENT_WORKER_NAME}/runtime-check`
    );
  });

  it('dispatches a friendly KV alias while keeping the private quick-deploy hostname hidden', async () => {
    await env.DEPLOY_KV.put(`slug2worker:${FRIENDLY_SLUG}`, PRIVATE_WORKER_NAME);
    await env.DEPLOY_KV.put(`worker2slug:${PRIVATE_WORKER_NAME}`, FRIENDLY_SLUG);
    await env.DEPLOY_KV.put(`slug2worker:${PRIVATE_WORKER_NAME}`, PRIVATE_WORKER_NAME);

    const mappedResponse = await SELF.fetch(`https://${FRIENDLY_SLUG}.d.kiloapps.io/runtime-check`);

    expect(mappedResponse.status).toBe(200);
    await expect(mappedResponse.text()).resolves.toBe(
      `fake internal worker served ${PRIVATE_WORKER_NAME}/runtime-check`
    );

    const privateResponse = await SELF.fetch(
      `https://${PRIVATE_WORKER_NAME}.d.kiloapps.io/runtime-check`
    );

    expect(privateResponse.status).toBe(404);
  });
});
