import { Hono, type Context } from 'hono';
import type { Env, HonoEnv, StatusResponse } from './types';
import {
  backendAuthMiddleware,
  createErrorHandler,
  createNotFoundHandler,
} from '@kilocode/worker-utils';
import { CloudflareAPI } from './cloudflare-api';
import { validateWorkerName } from './utils';
import * as Sentry from '@sentry/cloudflare';

import { DeploymentOrchestrator as DeploymentOrchestratorBase } from './deployment-orchestrator';
import { EventsManager as EventsManagerBase } from './events-manager';
import { htmlDeployHandler } from './html-deploy/handler';
import { runEphemeralDeploymentCleanup } from './html-deploy/ephemeral-cleanup';
export { Sandbox } from '@cloudflare/sandbox';

export const DeploymentOrchestrator = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA.id,
    sendDefaultPii: false,
    environment: env.ENVIRONMENT || 'production',
  }),
  DeploymentOrchestratorBase
);

export const EventsManager = Sentry.instrumentDurableObjectWithSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA.id,
    sendDefaultPii: false,
    environment: env.ENVIRONMENT || 'production',
  }),
  EventsManagerBase
);

// Create Hono app with Env type
const app = new Hono<HonoEnv>();

// ── /deploy-html — Kilo JWT auth, no sandbox, synchronous ─────────────────

app.post('/deploy-html', htmlDeployHandler);

// ── Backend-authenticated routes ───────────────────────────────────────────

app.use(
  '*',
  backendAuthMiddleware<HonoEnv>(c => c.env.BACKEND_AUTH_TOKEN)
);

app.on('POST', ['/deploy', '/deploy-archive'], c =>
  c.json(
    {
      error:
        'Deploy has reached end of life. New deployments and redeployments are no longer available.',
    },
    410
  )
);

// Route: GET /deploy/:buildId/status
app.get('/deploy/:buildId/status', async (c: Context<HonoEnv>) => {
  const buildId = c.req.param('buildId');
  if (!buildId) return c.json({ error: 'Missing buildId' }, 400);

  const id = c.env.DeploymentOrchestrator.idFromName(buildId);
  const stub = c.env.DeploymentOrchestrator.get(id);

  try {
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

  const id = c.env.DeploymentOrchestrator.idFromName(buildId);
  const stub = c.env.DeploymentOrchestrator.get(id);

  try {
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
 * Note: Assets are automatically cleaned up when the script is deleted
 */
app.delete('/worker/:slug', async (c: Context<HonoEnv>) => {
  const slug = c.req.param('slug');
  if (!slug) return c.json({ error: 'Missing slug' }, 400);

  try {
    validateWorkerName(slug);
  } catch (_error) {
    return c.json({ error: 'Invalid worker slug' }, 400);
  }

  const dispatchNamespace = 'kilo-deploy';

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

export default Sentry.withSentry(
  (env: Env) => {
    const { id: versionId } = env.CF_VERSION_METADATA;

    return {
      dsn: env.SENTRY_DSN,
      release: versionId,
      sendDefaultPii: false,
      environment: env.ENVIRONMENT || 'production',
    };
  },
  {
    fetch: app.fetch,

    async scheduled(
      _controller: ScheduledController,
      env: Env,
      ctx: ExecutionContext
    ): Promise<void> {
      ctx.waitUntil(
        runEphemeralDeploymentCleanup(env).catch(error => {
          Sentry.captureException(error, {
            extra: { action: 'html-deploy-postgres-cleanup-sweep' },
          });
        })
      );
    },
  } satisfies ExportedHandler<Env>
);
