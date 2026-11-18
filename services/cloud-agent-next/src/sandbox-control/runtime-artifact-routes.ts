import type { Hono } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { resolveSecret } from '../auth.js';
import { RUNTIME_ARTIFACT_HTTP_PREFIX, SHA256_PATTERN } from './runtime-release.js';
import { runtimeArtifactObjectKey } from './runtime-artifact-keys.js';
import { validateRuntimeArtifactGrant } from './runtime-artifact-grant.js';

export function registerRuntimeArtifactRoutes(app: Hono<HonoContext>): void {
  app.get(`${RUNTIME_ARTIFACT_HTTP_PREFIX}:sha256`, async c => {
    const signingSecret = await resolveSecret(c.env.NEXTAUTH_SECRET);
    // The bootstrap retries 5xx responses; 401 is a permanent startup failure.
    if (!signingSecret) return c.text('Authentication unavailable', 503);
    const grant = validateRuntimeArtifactGrant(
      c.req.header('Authorization') ?? null,
      signingSecret
    );
    if (!grant) return c.text('Unauthorized', 401);
    const hash = c.req.param('sha256');
    if (!SHA256_PATTERN.test(hash)) return c.text('Not found', 404);
    if (!grant.hashes.includes(hash)) return c.text('Forbidden', 403);
    if (!c.env.RUNTIME_RELEASE_BUCKET) return c.text('Artifact storage unavailable', 503);
    try {
      const object = await c.env.RUNTIME_RELEASE_BUCKET.get(runtimeArtifactObjectKey(hash));
      if (!object) return c.text('Not found', 404);
      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/zstd',
          'Content-Length': String(object.size),
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return c.text('Artifact storage unavailable', 503);
    }
  });
}
