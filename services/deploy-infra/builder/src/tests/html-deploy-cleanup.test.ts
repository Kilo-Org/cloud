const mockCaptureException = jest.fn();

jest.mock('@sentry/cloudflare', () => ({
  captureException: mockCaptureException,
}));

import * as dbClient from '@kilocode/db/client';
import type { WorkerDb } from '@kilocode/db/client';
import { CloudflareAPI } from '../cloudflare-api';
import {
  CLEANUP_BATCH_SIZE,
  CLEANUP_RETRY_DELAY_MS,
  PENDING_DEPLOYMENT_CLEANUP_MS,
  nextCleanupRetryAt,
  removeExpiredDeployment,
} from '../html-deploy/cleanup';
import {
  cleanUpClaimedEphemeralDeployment,
  rollBackFailedEphemeralDeployment,
  runEphemeralDeploymentCleanup,
} from '../html-deploy/ephemeral-cleanup';
import { HtmlDeployDispatcherClient } from '../html-deploy/dispatcher-client';
import * as repository from '../html-deploy/repository';
import type { Env } from '../types';

const db = {} as WorkerDb;

async function settleAsyncWork(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
} {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve: () => resolvePromise?.(),
    reject: error => rejectPromise?.(error),
  };
}

afterEach(() => {
  jest.restoreAllMocks();
  mockCaptureException.mockClear();
});

describe('HTML deployment expiry cleanup', () => {
  it('uses a fixed cleanup batch size', () => {
    expect(CLEANUP_BATCH_SIZE).toBe(25);
  });

  it('expires pending reservations after a short bootstrap timeout', () => {
    expect(PENDING_DEPLOYMENT_CLEANUP_MS).toBe(10 * 60 * 1000);
  });

  it('attempts mapping, banner, and Worker teardown independently and reports transient failures for retry', async () => {
    const deleted: string[] = [];

    const failures = await removeExpiredDeployment('qdpl-uuid', {
      async deleteMapping(workerName) {
        deleted.push(`mapping:${workerName}`);
        throw new Error('dispatcher unavailable');
      },
      async disableBanner(workerName) {
        deleted.push(`banner:${workerName}`);
        throw new Error('banner unavailable');
      },
      async deleteWorker(workerName) {
        deleted.push(`worker:${workerName}`);
      },
    });

    expect(deleted).toEqual(['mapping:qdpl-uuid', 'banner:qdpl-uuid', 'worker:qdpl-uuid']);
    expect(failures.map(failure => failure.target)).toEqual(['mapping', 'banner']);
  });

  it('marks Postgres retry state before immediate rollback teardown and attempts resources independently', async () => {
    const attempted: string[] = [];
    const retryState = deferred();
    const mappingDeletion = deferred();
    const bannerDeletion = deferred();
    const workerDeletion = deferred();
    jest.spyOn(repository, 'markEphemeralDeploymentForCleanup').mockImplementation(async () => {
      attempted.push('retry-state');
      await retryState.promise;
      return true;
    });
    const completeUnclaimed = jest
      .spyOn(repository, 'completeUnclaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);

    const rollback = rollBackFailedEphemeralDeployment(
      db,
      { deploymentId: 'deployment-uuid', workerName: 'qdpl-uuid' },
      {
        async deleteMapping(workerName) {
          attempted.push(`mapping:${workerName}`);
          await mappingDeletion.promise;
        },
        async disableBanner(workerName) {
          attempted.push(`banner:${workerName}`);
          await bannerDeletion.promise;
        },
        async deleteWorker(workerName) {
          attempted.push(`worker:${workerName}`);
          await workerDeletion.promise;
        },
      }
    );

    expect(attempted).toEqual(['retry-state']);

    retryState.resolve();
    await settleAsyncWork();
    expect(attempted).toEqual([
      'retry-state',
      'mapping:qdpl-uuid',
      'banner:qdpl-uuid',
      'worker:qdpl-uuid',
    ]);

    mappingDeletion.reject(new Error('dispatcher unavailable'));
    bannerDeletion.resolve();
    workerDeletion.resolve();
    const failures = await rollback;

    expect(failures.map(failure => failure.target)).toEqual(['mapping']);
    expect(completeUnclaimed).not.toHaveBeenCalled();
  });

  it('keeps the unclaimed Postgres row retryable when badge deletion fails', async () => {
    jest.spyOn(repository, 'markEphemeralDeploymentForCleanup').mockResolvedValue(true);
    const completeUnclaimed = jest
      .spyOn(repository, 'completeUnclaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);
    const deleteWorker = jest.fn().mockResolvedValue(undefined);

    const failures = await rollBackFailedEphemeralDeployment(
      db,
      { deploymentId: 'deployment-uuid', workerName: 'qdpl-uuid' },
      {
        deleteMapping: jest.fn().mockResolvedValue(undefined),
        disableBanner: jest.fn().mockRejectedValue(new Error('badge unavailable')),
        deleteWorker,
      }
    );

    expect(deleteWorker).toHaveBeenCalledWith('qdpl-uuid');
    expect(failures.map(failure => failure.target)).toEqual(['banner']);
    expect(completeUnclaimed).not.toHaveBeenCalled();
  });

  it('completes the unclaimed Postgres row after successful immediate rollback', async () => {
    jest.spyOn(repository, 'markEphemeralDeploymentForCleanup').mockResolvedValue(true);
    const completeUnclaimed = jest
      .spyOn(repository, 'completeUnclaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);

    const failures = await rollBackFailedEphemeralDeployment(
      db,
      { deploymentId: 'deployment-uuid', workerName: 'qdpl-uuid' },
      {
        deleteMapping: jest.fn().mockResolvedValue(undefined),
        disableBanner: jest.fn().mockResolvedValue(undefined),
        deleteWorker: jest.fn().mockResolvedValue(undefined),
      }
    );

    expect(failures).toEqual([]);
    expect(completeUnclaimed).toHaveBeenCalledWith(db, { internalWorkerName: 'qdpl-uuid' });
  });

  it('authenticates dispatcher cleanup with the dedicated dispatcher token', async () => {
    jest.spyOn(dbClient, 'getWorkerDb').mockReturnValue(db);
    jest.spyOn(repository, 'claimDueEphemeralDeployments').mockResolvedValue([
      {
        id: 'deployment-uuid',
        internalWorkerName: 'qdpl-uuid',
        deploymentSlug: 'friendly-slug',
      },
    ]);
    jest.spyOn(repository, 'completeClaimedEphemeralDeploymentCleanup').mockResolvedValue(true);
    jest.spyOn(repository, 'retryClaimedEphemeralDeploymentCleanup').mockResolvedValue(true);
    jest.spyOn(CloudflareAPI.prototype, 'deleteWorker').mockResolvedValue();
    const dispatcherRequests: Request[] = [];
    const deployDispatcher = {
      fetch: jest.fn(async (request: Request) => {
        dispatcherRequests.push(request);
        return new Response(null, { status: 204 });
      }),
    } as unknown as Fetcher;
    const env = {
      HYPERDRIVE: { connectionString: 'postgres://cleanup' },
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_API_TOKEN: 'api-token',
      BACKEND_AUTH_TOKEN: 'backend-token',
      DISPATCHER_AUTH_TOKEN: 'dispatcher-token',
      DeployDispatcher: deployDispatcher,
      DEPLOY_HOSTNAME_BASE: 'd.kiloapps.io',
    } as unknown as Env;

    await runEphemeralDeploymentCleanup(env);

    expect(dispatcherRequests).toHaveLength(2);
    expect(dispatcherRequests.map(request => request.headers.get('Authorization'))).toEqual([
      'Bearer dispatcher-token',
      'Bearer dispatcher-token',
    ]);
  });

  it('claims a batch and continues cleanup after a partial teardown failure', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const claimToken = '00000000-0000-4000-8000-000000000001';
    jest.spyOn(crypto, 'randomUUID').mockReturnValue(claimToken);
    jest.spyOn(dbClient, 'getWorkerDb').mockReturnValue(db);
    const claimDue = jest.spyOn(repository, 'claimDueEphemeralDeployments').mockResolvedValue([
      {
        id: 'successful-deployment',
        internalWorkerName: 'qdpl-success',
        deploymentSlug: 'successful-slug',
      },
      {
        id: 'partial-deployment',
        internalWorkerName: 'qdpl-partial',
        deploymentSlug: 'partial-slug',
      },
      {
        id: 'continued-deployment',
        internalWorkerName: 'qdpl-continued',
        deploymentSlug: 'continued-slug',
      },
    ]);
    const completeClaimed = jest
      .spyOn(repository, 'completeClaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);
    const retryClaimed = jest
      .spyOn(repository, 'retryClaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);
    const deleteMapping = jest
      .spyOn(HtmlDeployDispatcherClient.prototype, 'deleteSlugMapping')
      .mockImplementation(async workerName => {
        if (workerName === 'qdpl-partial') throw new Error('dispatcher unavailable');
      });
    const disableBanner = jest
      .spyOn(HtmlDeployDispatcherClient.prototype, 'disableBanner')
      .mockResolvedValue();
    const deleteWorker = jest.spyOn(CloudflareAPI.prototype, 'deleteWorker').mockResolvedValue();
    const env = {
      HYPERDRIVE: { connectionString: 'postgres://cleanup' },
      CLOUDFLARE_ACCOUNT_ID: 'account-id',
      CLOUDFLARE_API_TOKEN: 'api-token',
      BACKEND_AUTH_TOKEN: 'backend-token',
      DISPATCHER_AUTH_TOKEN: 'dispatcher-token',
      DeployDispatcher: {},
      DEPLOY_HOSTNAME_BASE: 'd.kiloapps.io',
    } as unknown as Env;

    await runEphemeralDeploymentCleanup(env);

    expect(claimDue).toHaveBeenCalledWith(db, {
      claimToken,
      now: new Date(1_000).toISOString(),
      claimedUntil: new Date(1_000 + 20 * 60 * 1000).toISOString(),
      limit: CLEANUP_BATCH_SIZE,
    });
    expect(deleteMapping.mock.calls.map(([workerName]) => workerName)).toEqual([
      'qdpl-success',
      'qdpl-partial',
      'qdpl-continued',
    ]);
    expect(disableBanner.mock.calls.map(([workerName]) => workerName)).toEqual([
      'qdpl-success',
      'qdpl-partial',
      'qdpl-continued',
    ]);
    expect(deleteWorker.mock.calls.map(([workerName]) => workerName)).toEqual([
      'qdpl-success',
      'qdpl-partial',
      'qdpl-continued',
    ]);
    expect(completeClaimed).toHaveBeenCalledWith(db, {
      deploymentId: 'successful-deployment',
      claimToken,
    });
    expect(completeClaimed).toHaveBeenCalledWith(db, {
      deploymentId: 'continued-deployment',
      claimToken,
    });
    expect(completeClaimed).not.toHaveBeenCalledWith(db, {
      deploymentId: 'partial-deployment',
      claimToken,
    });
    expect(retryClaimed).toHaveBeenCalledWith(db, {
      deploymentId: 'partial-deployment',
      claimToken,
      nextCleanupAt: new Date(1_000 + CLEANUP_RETRY_DELAY_MS).toISOString(),
    });
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      extra: { workerName: 'qdpl-partial', action: 'html-deploy-delete-mapping' },
    });
  });

  it('completes successful claimed cleanup using the claim token', async () => {
    const completeClaimed = jest
      .spyOn(repository, 'completeClaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);
    const retryClaimed = jest
      .spyOn(repository, 'retryClaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);

    const failures = await cleanUpClaimedEphemeralDeployment(
      db,
      'claim-uuid',
      {
        id: 'deployment-uuid',
        internalWorkerName: 'qdpl-uuid',
        deploymentSlug: 'friendly-slug',
      },
      {
        deleteMapping: jest.fn().mockResolvedValue(undefined),
        disableBanner: jest.fn().mockResolvedValue(undefined),
        deleteWorker: jest.fn().mockResolvedValue(undefined),
      }
    );

    expect(failures).toEqual([]);
    expect(completeClaimed).toHaveBeenCalledWith(db, {
      deploymentId: 'deployment-uuid',
      claimToken: 'claim-uuid',
    });
    expect(retryClaimed).not.toHaveBeenCalled();
  });

  it('retries claimed cleanup with the repository cleared-state transition after partial teardown failure', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const completeClaimed = jest
      .spyOn(repository, 'completeClaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);
    const retryClaimed = jest
      .spyOn(repository, 'retryClaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);
    const deleteWorker = jest.fn().mockResolvedValue(undefined);

    const failures = await cleanUpClaimedEphemeralDeployment(
      db,
      'claim-uuid',
      {
        id: 'deployment-uuid',
        internalWorkerName: 'qdpl-uuid',
        deploymentSlug: 'friendly-slug',
      },
      {
        deleteMapping: jest.fn().mockRejectedValue(new Error('dispatcher unavailable')),
        disableBanner: jest.fn().mockResolvedValue(undefined),
        deleteWorker,
      }
    );

    expect(deleteWorker).toHaveBeenCalledWith('qdpl-uuid');
    expect(failures.map(failure => failure.target)).toEqual(['mapping']);
    expect(retryClaimed).toHaveBeenCalledWith(db, {
      deploymentId: 'deployment-uuid',
      claimToken: 'claim-uuid',
      nextCleanupAt: new Date(1_000 + CLEANUP_RETRY_DELAY_MS).toISOString(),
    });
    expect(completeClaimed).not.toHaveBeenCalled();
  });

  it('retries claimed cleanup when badge deletion fails after attempting every teardown target', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const completeClaimed = jest
      .spyOn(repository, 'completeClaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);
    const retryClaimed = jest
      .spyOn(repository, 'retryClaimedEphemeralDeploymentCleanup')
      .mockResolvedValue(true);
    const deleteMapping = jest.fn().mockResolvedValue(undefined);
    const disableBanner = jest.fn().mockRejectedValue(new Error('badge unavailable'));
    const deleteWorker = jest.fn().mockResolvedValue(undefined);

    const failures = await cleanUpClaimedEphemeralDeployment(
      db,
      'claim-uuid',
      {
        id: 'deployment-uuid',
        internalWorkerName: 'qdpl-uuid',
        deploymentSlug: 'friendly-slug',
      },
      {
        deleteMapping,
        disableBanner,
        deleteWorker,
      }
    );

    expect(deleteMapping).toHaveBeenCalledWith('qdpl-uuid');
    expect(disableBanner).toHaveBeenCalledWith('qdpl-uuid');
    expect(deleteWorker).toHaveBeenCalledWith('qdpl-uuid');
    expect(failures.map(failure => failure.target)).toEqual(['banner']);
    expect(retryClaimed).toHaveBeenCalledWith(db, {
      deploymentId: 'deployment-uuid',
      claimToken: 'claim-uuid',
      nextCleanupAt: new Date(1_000 + CLEANUP_RETRY_DELAY_MS).toISOString(),
    });
    expect(completeClaimed).not.toHaveBeenCalled();
  });

  it('backs off retries for resources whose teardown failed', () => {
    const now = 1_000;

    expect(nextCleanupRetryAt(now)).toBe(now + CLEANUP_RETRY_DELAY_MS);
  });
});
