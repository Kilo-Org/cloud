import {
  ContainerCapacityUnavailableError,
  ContainerConcurrencyLimitError,
  ContainerUsageAdmissionError,
  isContainerConcurrencyExempt,
  type ClientRecordStartInput,
  type ContainerCapacityCheck,
  type ContainerCapacityRequest,
} from '@kilocode/container-usage';
import { readContainerCapacity } from '@kilocode/container-usage/capacity';
import { withTimeout } from '@kilocode/worker-utils';
import { getPgDb } from './db/pg.js';
import { logger } from './logger.js';
import type { Env } from './types.js';

export {
  ContainerCapacityUnavailableError,
  ContainerConcurrencyLimitError,
  FUNDED_CONTAINER_MINIMUM_MICRODOLLARS,
  getContainerCapacityFailureReason,
  isContainerConcurrencyExempt,
  LOW_BALANCE_CONTAINER_LIMIT,
  ORGANIZATION_CONTAINER_LIMIT,
  USER_CONTAINER_LIMIT,
  type ContainerCapacityCheck,
  type ContainerCapacityCheckpoint,
  type ContainerCapacityRequest,
  type ContainerConcurrencySubject,
} from '@kilocode/container-usage';
export { readContainerCapacity } from '@kilocode/container-usage/capacity';

const COUNT_TIMEOUT_MS = 10_000;
const CHECK_RETRY_DELAY_MS = 250;

type CapacityDependencies = {
  readCapacity?: (request: ContainerCapacityRequest) => Promise<ContainerCapacityCheck[]>;
  reserveCapacity?: (admission: ClientRecordStartInput['admission']) => Promise<void>;
};

type CapacityEnv = Pick<Env, 'CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED'> &
  Partial<Pick<Env, 'HYPERDRIVE'>>;

export async function assertContainerCapacity(
  env: CapacityEnv,
  request: ContainerCapacityRequest,
  dependencies: CapacityDependencies = {}
): Promise<void> {
  if (
    env.CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED === 'true' ||
    isContainerConcurrencyExempt(request)
  ) {
    await dependencies.reserveCapacity?.(undefined);
    return;
  }
  let exceededCheck: ContainerCapacityCheck | undefined;
  const check = async () => {
    if (dependencies.reserveCapacity) {
      await dependencies.reserveCapacity({ checkpoint: request.checkpoint });
      return;
    }
    // Identity-less legacy starts keep this read-only preflight instead of a meter reservation.
    const readCapacity =
      dependencies.readCapacity ??
      (input => {
        if (!env.HYPERDRIVE) throw new ContainerCapacityUnavailableError();
        return readContainerCapacity(getPgDb({ HYPERDRIVE: env.HYPERDRIVE }), input);
      });
    const exceeded = (await readCapacity(request)).find(check => check.live >= check.limit);
    if (exceeded) {
      exceededCheck = exceeded;
      throw new ContainerConcurrencyLimitError(
        exceeded.subject.type === 'org' ? 'organization' : 'personal',
        exceeded.limit
      );
    }
  };
  try {
    await withTimeout(
      (async () => {
        try {
          await check();
        } catch (error) {
          if (
            error instanceof ContainerConcurrencyLimitError ||
            error instanceof ContainerUsageAdmissionError
          ) {
            throw error;
          }
          await new Promise(resolve => setTimeout(resolve, CHECK_RETRY_DELAY_MS));
          await check();
        }
      })(),
      COUNT_TIMEOUT_MS,
      'Container capacity admission'
    );
  } catch (error) {
    if (error instanceof ContainerUsageAdmissionError) throw error;
    if (error instanceof ContainerConcurrencyLimitError) {
      const subject = error.accountType === 'organization' ? request.subject : request.actor;
      logger
        .withTags({ logTag: 'container_limit_reached', sandboxId: request.instanceId })
        .withFields({
          checkpoint: request.checkpoint,
          subjectType: subject.type,
          subjectId: subject.id,
          ...(exceededCheck === undefined ? {} : { live: exceededCheck.live }),
          limit: error.limit,
        })
        .error('Container concurrency limit reached');
      throw error;
    }
    logger
      .withTags({ logTag: 'container_limit_check_unavailable', sandboxId: request.instanceId })
      .withFields({
        checkpoint: request.checkpoint,
        errorName: error instanceof Error ? error.name : 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      .warn('Container capacity admission unavailable; refusing start');
    throw new ContainerCapacityUnavailableError();
  }
}
