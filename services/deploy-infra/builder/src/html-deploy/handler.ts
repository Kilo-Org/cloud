import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { verifyKiloBearerAgainstCurrentPepper } from '@kilocode/worker-utils/kilo-token-auth';
import * as Sentry from '@sentry/cloudflare';
import type { Context } from 'hono';
import staticWorkerContent from '../assets/static.worker.js';
import { CloudflareAPI } from '../cloudflare-api';
import { Deployer } from '../deployer';
import { DEPLOY_DISPATCH_NAMESPACE } from '../dispatch-namespace';
import type { DeploymentArtifacts, HonoEnv, HtmlDeployResponse } from '../types';
import { PENDING_DEPLOYMENT_CLEANUP_MS, type CleanupFailure } from './cleanup';
import { rollBackFailedEphemeralDeployment } from './ephemeral-cleanup';
import { HtmlDeployDispatcherClient } from './dispatcher-client';
import { allocateFriendlySlug } from './public-slug';
import { activateEphemeralDeployment, createPendingEphemeralDeployment } from './repository';
import { generateEphemeralDeploymentSlug } from './slug';
import { isStoredDeploymentSlug } from './stored-slug';
import {
  getUploadFormat,
  parseHtmlFile,
  parseMultipartFiles,
  parseTtlHeader,
  validateStaticAssets,
} from './validator';

const DEFAULT_HOSTNAME_BASE = 'd.kiloapps.io';
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

async function cleanUpFailedDeployment(
  db: WorkerDb,
  dispatcher: HtmlDeployDispatcherClient,
  cloudflareApi: CloudflareAPI,
  deploymentId: string,
  workerName: string,
  action: string
): Promise<void> {
  const failures = await rollBackFailedEphemeralDeployment(
    db,
    { deploymentId, workerName },
    {
      deleteMapping: name => dispatcher.deleteSlugMapping(name),
      disableBanner: name => dispatcher.disableBanner(name),
      deleteWorker: name => cloudflareApi.deleteWorker(name, DEPLOY_DISPATCH_NAMESPACE),
    }
  );

  for (const failure of failures) {
    captureRollbackFailure(failure, workerName, action);
  }
}

function captureRollbackFailure(failure: CleanupFailure, workerName: string, action: string): void {
  Sentry.captureException(failure.error, {
    extra: { workerName, action, target: failure.target },
  });
}

export async function htmlDeployHandler(c: Context<HonoEnv>): Promise<Response> {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const authResult = await verifyKiloBearerAgainstCurrentPepper({
    token,
    nextAuthSecret: c.env.NEXTAUTH_SECRET,
    workerEnv: c.env.WORKER_ENV,
    connectionString: c.env.HYPERDRIVE.connectionString,
  });

  if (!authResult) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }

  const rateLimitResult = await c.env.HtmlDeployRateLimiter.limit({ key: authResult.userId });
  if (!rateLimitResult.success) {
    return c.json({ error: 'Too many HTML deployment requests' }, 429);
  }

  const uploadFormat = getUploadFormat(c.req.header('Content-Type') ?? '');
  if (uploadFormat === null) {
    return c.json({ error: 'Content-Type must be text/html or multipart/form-data' }, 415);
  }

  let ttlSeconds: number;
  try {
    ttlSeconds = parseTtlHeader(c.req.header('X-Expires-In') ?? null, {
      defaultTtl: DEFAULT_TTL_SECONDS,
      maxTtl: MAX_TTL_SECONDS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid X-Expires-In header';
    return c.json({ error: message }, 400);
  }

  let assets: DeploymentArtifacts['assets'];
  try {
    assets =
      uploadFormat === 'multipart'
        ? await parseMultipartFiles(c.req.raw)
        : await parseHtmlFile(c.req.raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to parse upload body';
    return c.json({ error: message }, 400);
  }

  if (assets.length === 0) {
    return c.json({ error: 'No files provided' }, 400);
  }

  const validationError = validateStaticAssets(assets);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  const workerName = `qdpl-${crypto.randomUUID()}`;
  const db = getWorkerDb(c.env.HYPERDRIVE.connectionString);
  let deploymentId: string;

  try {
    const pending = await createPendingEphemeralDeployment(db, {
      ownedByUserId: authResult.userId,
      internalWorkerName: workerName,
      pendingCleanupAt: new Date(Date.now() + PENDING_DEPLOYMENT_CLEANUP_MS).toISOString(),
    });
    if (!pending.created) {
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
    deploymentId = pending.deployment.id;
  } catch (error) {
    Sentry.captureException(error, {
      extra: { workerName, action: 'html-deploy-pending-insert' },
    });
    return c.json({ error: 'Failed to record deployment' }, 500);
  }

  const artifacts: DeploymentArtifacts = {
    workerScript: {
      path: 'index.js',
      content: Buffer.from(staticWorkerContent, 'utf-8'),
      mimeType: 'application/javascript+module',
    },
    artifacts: [],
    assets,
  };
  const hostnameBase = c.env.DEPLOY_HOSTNAME_BASE || DEFAULT_HOSTNAME_BASE;
  const cloudflareApi = new CloudflareAPI(c.env.CLOUDFLARE_ACCOUNT_ID, c.env.CLOUDFLARE_API_TOKEN);
  const deployer = new Deployer(cloudflareApi);
  const dispatcher = new HtmlDeployDispatcherClient(
    c.env.DeployDispatcher,
    c.env.DISPATCHER_AUTH_TOKEN,
    hostnameBase
  );

  try {
    await deployer.deploy({
      artifacts,
      workerName,
      logger: (message: string) => console.log(`[deploy-html ${workerName}] ${message}`),
    });
  } catch (error) {
    Sentry.captureException(error, {
      extra: { workerName, path: '/deploy-html', method: 'POST' },
    });
    await cleanUpFailedDeployment(
      db,
      dispatcher,
      cloudflareApi,
      deploymentId,
      workerName,
      'html-deploy-deployment-rollback'
    );
    const message = error instanceof Error ? error.message : 'Unknown deployment error';
    return c.json({ error: `Deployment failed: ${message}` }, 500);
  }

  let slug: string;
  try {
    slug = await allocateFriendlySlug({
      generate: () => generateEphemeralDeploymentSlug(),
      isStored: candidate => isStoredDeploymentSlug(db, candidate),
      map: candidate => dispatcher.setSlugMapping(workerName, candidate),
    });
  } catch (mappingError) {
    Sentry.captureException(mappingError, {
      extra: { workerName, action: 'html-deploy-slug-allocation' },
    });
    await cleanUpFailedDeployment(
      db,
      dispatcher,
      cloudflareApi,
      deploymentId,
      workerName,
      'html-deploy-allocation-rollback'
    );
    return c.json({ error: 'Failed to allocate an available deployment URL' }, 500);
  }

  try {
    await dispatcher.enableBanner(workerName);
  } catch (error) {
    Sentry.captureException(error, {
      extra: { slug, workerName, action: 'html-deploy-enable-banner' },
    });
  }

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  try {
    const activated = await activateEphemeralDeployment(db, {
      deploymentId,
      deploymentSlug: slug,
      expiresAt,
      now: new Date().toISOString(),
    });
    if (!activated) {
      throw new Error('HTML deployment pending lifecycle row lost');
    }
  } catch (error) {
    Sentry.captureException(error, {
      extra: { slug, workerName, action: 'html-deploy-postgres-activation' },
    });
    await cleanUpFailedDeployment(
      db,
      dispatcher,
      cloudflareApi,
      deploymentId,
      workerName,
      'html-deploy-activation-rollback'
    );
    return c.json({ error: 'Failed to record deployment' }, 500);
  }

  const response: HtmlDeployResponse = {
    slug,
    url: `https://${slug}.${hostnameBase}`,
    expires_at: expiresAt,
  };

  return c.json(response, 200);
}
