import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import * as Sentry from '@sentry/cloudflare';
import { CloudflareAPI } from '../cloudflare-api';
import { DEPLOY_DISPATCH_NAMESPACE } from '../dispatch-namespace';
import type { Env } from '../types';
import {
  CLEANUP_BATCH_SIZE,
  nextCleanupRetryAt,
  removeExpiredDeployment,
  type CleanupFailure,
} from './cleanup';
import { HtmlDeployDispatcherClient } from './dispatcher-client';
import {
  claimDueEphemeralDeployments,
  completeClaimedEphemeralDeploymentCleanup,
  completeUnclaimedEphemeralDeploymentCleanup,
  markEphemeralDeploymentForCleanup,
  retryClaimedEphemeralDeploymentCleanup,
  type ClaimedEphemeralDeployment,
} from './repository';

export const EPHEMERAL_CLEANUP_CLAIM_MS = 20 * 60 * 1000;

export async function rollBackFailedEphemeralDeployment(
  db: WorkerDb,
  params: { deploymentId: string; workerName: string },
  dependencies: {
    deleteMapping(workerName: string): Promise<void>;
    disableBanner(workerName: string): Promise<void>;
    deleteWorker(workerName: string): Promise<void>;
  }
): Promise<CleanupFailure[]> {
  const retryStateFailures = await attemptCleanupTargets([
    {
      target: 'retry-state',
      run: async () => {
        const marked = await markEphemeralDeploymentForCleanup(db, {
          deploymentId: params.deploymentId,
          internalWorkerName: params.workerName,
          now: new Date().toISOString(),
        });
        if (!marked) {
          logConcurrentCleanupTransition(params.workerName, 'retry-state');
        }
      },
    },
  ]);
  const teardownFailures = await removeExpiredDeployment(params.workerName, dependencies);

  if (teardownFailures.length > 0) {
    return [...retryStateFailures, ...teardownFailures];
  }

  const rowDeleteFailures = await attemptCleanupTargets([
    {
      target: 'row-delete',
      run: async () => {
        const completed = await completeUnclaimedEphemeralDeploymentCleanup(db, {
          internalWorkerName: params.workerName,
        });
        if (!completed) {
          logConcurrentCleanupTransition(params.workerName, 'row-delete');
        }
      },
    },
  ]);

  return [...retryStateFailures, ...rowDeleteFailures];
}

export async function runEphemeralDeploymentCleanup(env: Env): Promise<void> {
  const db = getWorkerDb(env.HYPERDRIVE.connectionString);
  const now = Date.now();
  const claimToken = crypto.randomUUID();
  const claimed = await claimDueEphemeralDeployments(db, {
    claimToken,
    now: new Date(now).toISOString(),
    claimedUntil: new Date(now + EPHEMERAL_CLEANUP_CLAIM_MS).toISOString(),
    limit: CLEANUP_BATCH_SIZE,
  });
  const cloudflareApi = new CloudflareAPI(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN);
  const dispatcher = new HtmlDeployDispatcherClient(
    env.DeployDispatcher,
    env.DISPATCHER_AUTH_TOKEN,
    env.DEPLOY_HOSTNAME_BASE
  );

  for (const deployment of claimed) {
    const failures = await cleanUpClaimedEphemeralDeployment(db, claimToken, deployment, {
      deleteMapping: workerName => dispatcher.deleteSlugMapping(workerName),
      disableBanner: workerName => dispatcher.disableBanner(workerName),
      deleteWorker: workerName => cloudflareApi.deleteWorker(workerName, DEPLOY_DISPATCH_NAMESPACE),
    });

    for (const failure of failures) {
      captureCleanupFailure(failure, deployment.internalWorkerName);
    }
  }
}

export async function cleanUpClaimedEphemeralDeployment(
  db: WorkerDb,
  claimToken: string,
  deployment: ClaimedEphemeralDeployment,
  dependencies: {
    deleteMapping(workerName: string): Promise<void>;
    disableBanner(workerName: string): Promise<void>;
    deleteWorker(workerName: string): Promise<void>;
  }
): Promise<CleanupFailure[]> {
  const teardownFailures = await removeExpiredDeployment(
    deployment.internalWorkerName,
    dependencies
  );

  if (teardownFailures.length === 0) {
    const rowDeleteFailures = await attemptCleanupTargets([
      {
        target: 'row-delete',
        run: async () => {
          const completed = await completeClaimedEphemeralDeploymentCleanup(db, {
            deploymentId: deployment.id,
            claimToken,
          });
          if (!completed) {
            logConcurrentCleanupTransition(deployment.internalWorkerName, 'row-delete');
          }
        },
      },
    ]);
    return rowDeleteFailures;
  }

  const retryStateFailures = await attemptCleanupTargets([
    {
      target: 'retry-state',
      run: async () => {
        const retried = await retryClaimedEphemeralDeploymentCleanup(db, {
          deploymentId: deployment.id,
          claimToken,
          nextCleanupAt: new Date(nextCleanupRetryAt(Date.now())).toISOString(),
        });
        if (!retried) {
          logConcurrentCleanupTransition(deployment.internalWorkerName, 'retry-state');
        }
      },
    },
  ]);

  return [...teardownFailures, ...retryStateFailures];
}

async function attemptCleanupTargets(
  targets: { target: CleanupFailure['target']; run(): Promise<void> }[]
): Promise<CleanupFailure[]> {
  const results = await Promise.allSettled(targets.map(target => target.run()));
  const failures: CleanupFailure[] = [];

  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      failures.push({ target: targets[index].target, error: result.reason });
    }
  }

  return failures;
}

function logConcurrentCleanupTransition(
  workerName: string,
  action: CleanupFailure['target']
): void {
  console.log(
    JSON.stringify({
      message: 'Skipped ephemeral deployment cleanup state transition after concurrent mutation',
      workerName,
      action,
    })
  );
}

function captureCleanupFailure(failure: CleanupFailure, workerName: string): void {
  Sentry.captureException(failure.error, {
    extra: { workerName, action: `html-deploy-delete-${failure.target}` },
  });
}
