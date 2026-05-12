import { Hono, type Context } from 'hono';
import type {
  Env,
  DeployRequest,
  DeployResponse,
  StatusResponse,
  HtmlDeployResponse,
  HtmlDeployRecord,
  DeploymentArtifacts,
} from './types';
import {
  backendAuthMiddleware,
  createErrorHandler,
  createNotFoundHandler,
  verifyKiloToken,
} from '@kilocode/worker-utils';
import { CloudflareAPI } from './cloudflare-api';
import { Deployer } from './deployer';
import { validateWorkerName } from './utils';
import * as Sentry from '@sentry/cloudflare';
import staticWorkerContent from './assets/static.worker.js';

// Import base Durable Objects
import { DeploymentOrchestrator as DeploymentOrchestratorBase } from './deployment-orchestrator';
import { EventsManager as EventsManagerBase } from './events-manager';
export { Sandbox } from '@cloudflare/sandbox';

// Export Sentry-instrumented Durable Objects
export const DeploymentOrchestrator = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA.id,
    sendDefaultPii: true,
    environment: env.ENVIRONMENT || 'production',
  }),
  DeploymentOrchestratorBase
);

export const EventsManager = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA.id,
    sendDefaultPii: true,
    environment: env.ENVIRONMENT || 'production',
  }),
  EventsManagerBase
);

function createDurableObjectBuilderID() {
  return crypto.randomUUID();
}

// Create Hono app with Env type
type HonoEnv = { Bindings: Env };
const app = new Hono<HonoEnv>();

const MAX_HTML_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_HOSTNAME_BASE = 'd.kiloapps.io';
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const KV_KEY_PREFIX = 'html-deploy:';

const HTML_TAG_RE = /<!DOCTYPE\s+html|<html[\s>]/i;

function generateHtmlSlug(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const random = crypto.getRandomValues(new Uint8Array(12));
  const suffix = Array.from(random)
    .map(b => chars[b % chars.length])
    .join('');
  return `ksd-${suffix}`;
}

function parseTtlHeader(header: string | null): number {
  if (!header) return DEFAULT_TTL_SECONDS;
  const seconds = parseInt(header, 10);
  if (isNaN(seconds) || seconds <= 0) return DEFAULT_TTL_SECONDS;
  return Math.min(seconds, MAX_TTL_SECONDS);
}

// ── /deploy-html — Kilo JWT auth, no sandbox, synchronous ─────────────────

app.post('/deploy-html', async (c: Context<HonoEnv>) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const secret = await c.env.NEXTAUTH_SECRET.get();
  if (!secret) {
    return c.json({ error: 'Server misconfiguration' }, 500);
  }

  try {
    await verifyKiloToken(authHeader.slice(7), secret);
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  const html = await c.req.text();

  if (!html || html.length === 0) {
    return c.json({ error: 'Empty HTML body' }, 400);
  }

  if (html.length > MAX_HTML_BYTES) {
    return c.json(
      { error: `HTML body exceeds the ${MAX_HTML_BYTES / (1024 * 1024)} MB limit` },
      400
    );
  }

  if (!HTML_TAG_RE.test(html)) {
    return c.json(
      {
        error:
          'Content does not appear to be a valid HTML document (missing <!DOCTYPE html> or <html> tag)',
      },
      400
    );
  }

  const slug = generateHtmlSlug();
  const hostnameBase = c.env.DEPLOY_HOSTNAME_BASE || DEFAULT_HOSTNAME_BASE;
  const ttlSeconds = parseTtlHeader(c.req.header('X-Expires-In') ?? null);
  const expiresAt = Date.now() + ttlSeconds * 1000;

  const artifacts: DeploymentArtifacts = {
    workerScript: {
      path: 'index.js',
      content: Buffer.from(staticWorkerContent, 'utf-8'),
      mimeType: 'application/javascript+module',
    },
    artifacts: [],
    assets: [
      {
        path: 'index.html',
        content: Buffer.from(html, 'utf-8'),
        mimeType: 'text/html',
      },
    ],
  };

  const cloudflareApi = new CloudflareAPI(c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN);
  const deployer = new Deployer(cloudflareApi);

  try {
    await deployer.deploy({
      artifacts,
      workerName: slug,
      logger: (msg: string) => console.log(`[deploy-html ${slug}] ${msg}`),
    });
  } catch (error) {
    Sentry.captureException(error, {
      extra: { slug, path: '/deploy-html', method: 'POST' },
    });
    const msg = error instanceof Error ? error.message : 'Unknown deployment error';
    return c.json({ error: `Deployment failed: ${msg}` }, 500);
  }

  const record: HtmlDeployRecord = { slug, expiresAt };
  await c.env.HTML_DEPLOYMENTS_KV.put(`${KV_KEY_PREFIX}${slug}`, JSON.stringify(record));

  const response: HtmlDeployResponse = {
    slug,
    url: `https://${slug}.${hostnameBase}`,
    expires_at: new Date(expiresAt).toISOString(),
  };

  return c.json(response, 200);
});

// ── Backend-authenticated routes ───────────────────────────────────────────

// Authentication middleware
app.use(
  '*',
  backendAuthMiddleware<HonoEnv>(c => c.env.BACKEND_AUTH_TOKEN)
);

// Route: POST /deploy
app.post('/deploy', async (c: Context<HonoEnv>) => {
  let body: DeployRequest;

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Handle build cancellations if provided
  if (body.cancelBuildIds && body.cancelBuildIds.length > 0) {
    await Promise.allSettled(
      body.cancelBuildIds.map(async buildId => {
        try {
          const id = c.env.DeploymentOrchestrator.idFromName(buildId);
          const stub = c.env.DeploymentOrchestrator.get(id);
          await stub.cancel('due to newer deployment');
        } catch (error) {
          Sentry.captureException(error, {
            level: 'warning',
          });
        }
      })
    );
  }

  // Validate required fields
  if (!body.slug || !body.provider || !body.repoSource) {
    return c.json({ error: 'Missing required fields: slug, provider, repoSource' }, 400);
  }

  // Validate slug format
  try {
    validateWorkerName(body.slug);
  } catch (_error) {
    return c.json({ error: 'Invalid worker slug' }, 400);
  }

  // Generate unique job ID
  const buildId = createDurableObjectBuilderID();

  // Get Durable Object stub
  const id = c.env.DeploymentOrchestrator.idFromName(buildId);
  const stub = c.env.DeploymentOrchestrator.get(id);

  // Start the job via RPC
  const result = await stub.start({
    buildId,
    slug: body.slug,
    source: {
      type: 'git',
      provider: body.provider,
      repoSource: body.repoSource,
      accessToken: body.accessToken,
      branch: body.branch,
    },
    envVars: body.envVars,
  });

  // Return 202 Accepted with job details
  const response: DeployResponse = {
    buildId,
    slug: body.slug,
    status: result.status,
  };

  return c.json(response, 202);
});

// Route: POST /deploy-archive - Deploy from uploaded tar.gz archive
app.post('/deploy-archive', async (c: Context<HonoEnv>) => {
  const slug = c.req.header('X-Slug');

  if (!slug) {
    return c.json({ error: 'Missing X-Slug header' }, 400);
  }

  // Validate slug format
  try {
    validateWorkerName(slug);
  } catch (_error) {
    return c.json({ error: 'Invalid worker slug' }, 400);
  }

  // Parse optional env vars from header
  const envVarsHeader = c.req.header('X-Env-Vars');
  let envVars: DeployRequest['envVars'] | undefined;
  if (envVarsHeader) {
    try {
      envVars = JSON.parse(envVarsHeader) as DeployRequest['envVars'];
    } catch {
      return c.json({ error: 'Invalid X-Env-Vars header: must be valid JSON' }, 400);
    }
  }

  // Read archive from body
  const archiveBuffer = await c.req.arrayBuffer();

  if (archiveBuffer.byteLength === 0) {
    return c.json({ error: 'Empty archive body' }, 400);
  }

  // Generate unique job ID
  const buildId = createDurableObjectBuilderID();

  // Get Durable Object stub
  const id = c.env.DeploymentOrchestrator.idFromName(buildId);
  const stub = c.env.DeploymentOrchestrator.get(id);

  // Start the job via RPC with archive source
  const result = await stub.startFromArchive({
    buildId,
    slug,
    archiveBuffer: new Uint8Array(archiveBuffer),
    envVars,
  });

  // Return 202 Accepted with job details
  const response: DeployResponse = {
    buildId,
    slug,
    status: result.status,
  };

  return c.json(response, 202);
});

// Route: GET /deploy/:buildId/status
app.get('/deploy/:buildId/status', async (c: Context<HonoEnv>) => {
  const buildId = c.req.param('buildId');
  if (!buildId) return c.json({ error: 'Missing buildId' }, 400);

  // Get Durable Object stub
  const id = c.env.DeploymentOrchestrator.idFromName(buildId);
  const stub = c.env.DeploymentOrchestrator.get(id);

  try {
    // Fetch status from Durable Object via RPC
    const status: StatusResponse = await stub.status();
    return c.json(status, 200);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage === 'Job not found') {
      return c.json({ error: 'Job not found' }, 404);
    }
    throw error;
  }
});

// Route: GET /deploy/:buildId/events
app.get('/deploy/:buildId/events', async (c: Context<HonoEnv>) => {
  const buildId = c.req.param('buildId');
  if (!buildId) return c.json({ error: 'Missing buildId' }, 400);

  // Get Durable Object stub
  const id = c.env.DeploymentOrchestrator.idFromName(buildId);
  const stub = c.env.DeploymentOrchestrator.get(id);

  try {
    // Fetch events from Durable Object via RPC
    const events = await stub.events();
    return c.json(events, 200);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (errorMessage === 'Job not found') {
      return c.json({ error: 'Job not found' }, 404);
    }
    throw error;
  }
});

// Route: DELETE /deploy/:buildId
app.delete('/deploy/:buildId', async (c: Context<HonoEnv>) => {
  const buildId = c.req.param('buildId');
  if (!buildId) return c.json({ error: 'Missing buildId' }, 400);

  // Get Durable Object stub
  const id = c.env.DeploymentOrchestrator.idFromName(buildId);
  const stub = c.env.DeploymentOrchestrator.get(id);

  try {
    const success = await stub.cancel('initiated by user');

    if (success) {
      return c.json({ success: true }, 200);
    } else {
      return c.json({ success: false }, 400);
    }
  } catch (_error) {
    return c.json({ success: false }, 500);
  }
});

/**
 * Delete a worker from the dispatch namespace
 * Note: Assets are automatically cleaned up when the script is deleted
 */
app.delete('/worker/:slug', async (c: Context<HonoEnv>) => {
  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'Missing slug' }, 400);

  // Validate slug format
  try {
    validateWorkerName(slug);
  } catch (_error) {
    return c.json({ error: 'Invalid worker slug' }, 400);
  }

  const dispatchNamespace = 'kilo-deploy'; // Hardcoded for now

  try {
    const cloudflareApi = new CloudflareAPI(
      c.env.CLOUDFLARE_ACCOUNT_ID,
      c.env.CLOUDFLARE_API_TOKEN
    );
    await cloudflareApi.deleteWorker(slug, dispatchNamespace);

    return c.json({
      success: true,
      message: `Worker ${slug} deleted successfully. Assets are automatically cleaned up.`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: `Failed to delete worker: ${errorMessage}` }, 500);
  }
});

// Global error handler
const errorHandler = createErrorHandler(console, { includeMessage: false });
app.onError((err, c) => {
  Sentry.captureException(err, {
    extra: {
      path: c.req.path,
      method: c.req.method,
    },
  });

  return errorHandler(err, c);
});

// 404 handler
app.notFound(createNotFoundHandler());

// ── Scheduled handler: auto-delete expired HTML deployments ────────────────

async function cleanupExpiredDeployments(env: Env): Promise<void> {
  const now = Date.now();
  const list = await env.HTML_DEPLOYMENTS_KV.list({ prefix: KV_KEY_PREFIX });
  const dispatchNamespace = 'kilo-deploy';
  const cloudflareApi = new CloudflareAPI(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);

  for (const key of list.keys) {
    const raw = await env.HTML_DEPLOYMENTS_KV.get(key.name);
    if (!raw) continue;

    let record: HtmlDeployRecord;
    try {
      record = JSON.parse(raw) as HtmlDeployRecord;
    } catch {
      await env.HTML_DEPLOYMENTS_KV.delete(key.name);
      continue;
    }

    if (record.expiresAt <= now) {
      try {
        await cloudflareApi.deleteWorker(record.slug, dispatchNamespace);
        console.log(`[cleanup] Deleted expired HTML deployment: ${record.slug}`);
      } catch (error) {
        Sentry.captureException(error, {
          extra: { slug: record.slug, action: 'html-deploy-cleanup' },
        });
        const errMsg = error instanceof Error ? error.message : String(error);
        console.error(`[cleanup] Failed to delete ${record.slug}: ${errMsg}`);
      }
      await env.HTML_DEPLOYMENTS_KV.delete(key.name);
    }
  }
}

const fetchHandler = Sentry.withSentry((env: Env) => {
  const { id: versionId } = env.CF_VERSION_METADATA;

  return {
    dsn: env.SENTRY_DSN,
    release: versionId,
    sendDefaultPii: true,
    environment: env.ENVIRONMENT || 'production',
  };
}, app);

export default {
  fetch: fetchHandler,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupExpiredDeployments(env));
  },
};
