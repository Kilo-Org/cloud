import type { Hono, Context } from 'hono';
import type { HonoContext } from '../hono-context.js';
import { resolveSecret } from '../auth.js';
import { logger } from '../logger.js';
import { RUNTIME_ARTIFACT_HTTP_PREFIX, SHA256_PATTERN } from '../shared/runtime-release.js';
import { runtimeArtifactObjectKey } from './runtime-artifact-store.js';
import {
  RUNTIME_ARTIFACT_GRANT_MAX_HEADER_LENGTH,
  runtimeArtifactGrantAllows,
  validateRuntimeArtifactGrant,
} from './runtime-artifact-grant.js';

/**
 * Private artifact read route (plan §7 "Artifact Access").
 *
 * It reads only its fixed object prefix, and only for one of the two hashes the
 * grant names. An artifact hash alone does not grant access to arbitrary objects;
 * there is no manifest fetch and no bucket traversal here. The HTTP prefix is the
 * shared owner in `runtime-release.ts`, so the installer fetch URL and live tests
 * cannot drift from this route.
 */
export const RUNTIME_ARTIFACT_ROUTE_PATH = `${RUNTIME_ARTIFACT_HTTP_PREFIX}:sha256`;

async function handleRuntimeArtifactRead(c: Context<HonoContext>): Promise<Response> {
  const authorization = c.req.header('Authorization') ?? null;
  if (authorization !== null && authorization.length > RUNTIME_ARTIFACT_GRANT_MAX_HEADER_LENGTH) {
    return c.text('Unauthorized', 401);
  }
  const grant = validateRuntimeArtifactGrant(
    authorization,
    await resolveSecret(c.env.NEXTAUTH_SECRET)
  );
  if (!grant) return c.text('Unauthorized', 401);

  const sha256 = c.req.param('sha256') ?? '';
  // A single fixed segment that is exactly a hex digest: no traversal, no
  // additional path components, no unsupported hashes.
  if (!SHA256_PATTERN.test(sha256)) return c.text('Not found', 404);
  if (!runtimeArtifactGrantAllows(grant, sha256)) return c.text('Forbidden', 403);

  const object = await c.env.RUNTIME_RELEASE_BUCKET.get(runtimeArtifactObjectKey(sha256));
  if (object === null) {
    logger.withFields({ sha256 }).warn('runtime artifact read missed the object store');
    return c.text('Not found', 404);
  }
  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'application/gzip',
      'Content-Length': String(object.size),
      'Cache-Control': 'no-store',
    },
  });
}

export function registerRuntimeArtifactRoutes(app: Hono<HonoContext>): void {
  app.get(RUNTIME_ARTIFACT_ROUTE_PATH, handleRuntimeArtifactRead);
}
