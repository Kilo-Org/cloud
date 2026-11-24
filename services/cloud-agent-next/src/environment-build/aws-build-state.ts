import { z } from 'zod';
import {
  awsEcsOperationSchema,
  type AwsEcsOperation,
} from '../sandbox-control/aws-ecs-operation.js';
import type { AwsComputeStorage } from '../sandbox-control/aws-compute-lifecycle.js';
import { awsEcsArchiveBaseImage } from '../shared/aws-archive.js';
import { awsBuildArchiveStateSchema } from './aws-archive-storage.js';
import { buildScmGrantSchema } from './scm-credentials.js';
import type { AwsBuilderAllocation } from './aws-build-target.js';
import type { BuilderLifecycleState } from './builder-state.js';
import { BuilderStateInvalidError } from './builder-errors.js';

const stateSchema = z
  .object({
    format: z.literal(1),
    operation: awsEcsOperationSchema.optional(),
    credentialHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    scm: z.union([buildScmGrantSchema, z.literal('retired')]).optional(),
    archive: awsBuildArchiveStateSchema.optional(),
  })
  .strict();
export type AwsBuildState = z.infer<typeof stateSchema>;

/** One build owns the cell; each operation updates only its own field. */
export function readAwsBuildState(raw: unknown, allocation: AwsBuilderAllocation): AwsBuildState {
  if (raw === undefined) return { format: 1 };
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) throw new BuilderStateInvalidError();
  const state = parsed.data;
  const operation = state.operation;
  if (
    operation &&
    (operation.ref.sandboxId !== allocation.sandboxId ||
      operation.ref.intentId !== allocation.allocationId ||
      awsEcsArchiveBaseImage(allocation.target.credentialId, operation.config) !==
        allocation.target.baseImage)
  )
    throw new BuilderStateInvalidError();
  if (state.archive && state.archive.descriptor.baseImage !== allocation.target.baseImage)
    throw new BuilderStateInvalidError();
  const grant = state.scm;
  if (
    grant &&
    grant !== 'retired' &&
    (grant.provider !== allocation.provider ||
      grant.environmentId !== allocation.environmentId ||
      grant.buildId !== allocation.buildId ||
      grant.allocationId !== allocation.allocationId ||
      grant.sandboxId !== allocation.sandboxId ||
      grant.userId !== allocation.actorUserId ||
      (allocation.owner.type === 'organization'
        ? grant.orgId !== allocation.owner.id
        : grant.orgId !== undefined))
  )
    throw new BuilderStateInvalidError();
  return state;
}

/** Reuse the common AWS lifecycle with exactly one immutable allocation per build. */
export function createAwsBuilderOperationStorage(input: {
  allocation: AwsBuilderAllocation;
  state: BuilderLifecycleState;
  beforeLaunch(): void;
}): AwsComputeStorage<AwsEcsOperation> {
  const read = (value: unknown) => readAwsBuildState(value, input.allocation);
  function owned(id: string) {
    if (id !== input.allocation.allocationId) throw new BuilderStateInvalidError();
  }
  return {
    async get(id) {
      owned(id);
      return read(await input.state.get()).operation;
    },
    async update(id, transition) {
      owned(id);
      const next = await input.state.update(raw => {
        const state = read(raw);
        const operation = awsEcsOperationSchema.parse(transition(state.operation));
        if (
          !state.operation ||
          (state.operation.phase === 'created' && operation.phase === 'launching')
        )
          input.beforeLaunch();
        return read({ ...state, operation });
      });
      return awsEcsOperationSchema.parse(read(next).operation);
    },
    async list() {
      const state = read(await input.state.get());
      return state.operation
        ? new Map([[input.allocation.allocationId, state.operation]])
        : new Map();
    },
    async delete(id) {
      owned(id);
      await input.state.update(raw => {
        const { operation: _operation, ...rest } = read(raw);
        return rest;
      });
    },
  };
}
