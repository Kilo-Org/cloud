import { z } from 'zod';
import { buildScmGrantSchema } from './scm-credentials.js';
import type { AwsEc2BuilderAllocation } from './aws-ec2-build-target.js';
import { awsEc2FilesystemBase } from '../byoc/aws-ec2-provider.js';
import { awsEc2WorkspaceSchema } from '../sandbox-control/aws-ec2-lifecycle.js';
import { awsEc2SnapshotOperationSchema } from '../sandbox-control/aws-ec2-snapshot.js';
import { BuilderStateInvalidError } from './builder-errors.js';

const stateSchema = z
  .object({
    format: z.literal(1),
    scm: z.union([buildScmGrantSchema, z.literal('retired')]).optional(),
    workspace: awsEc2WorkspaceSchema.optional(),
    capture: z.object({ id: z.uuid(), operation: awsEc2SnapshotOperationSchema }).optional(),
  })
  .strict();
export type AwsBuildState = z.infer<typeof stateSchema>;

/** One build owns the cell; each operation updates only its own field. */
export function readAwsBuildState(
  raw: unknown,
  allocation: AwsEc2BuilderAllocation
): AwsBuildState {
  if (raw === undefined) return { format: 1 };
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) throw new BuilderStateInvalidError();
  const state = parsed.data;
  const workspace = state.workspace;
  if (
    workspace &&
    (workspace.sandboxId !== allocation.sandboxId ||
      workspace.allocation.id !== allocation.allocationId ||
      awsEc2FilesystemBase(allocation.target.credentialId, workspace.config) !==
        allocation.target.baseImage)
  )
    throw new BuilderStateInvalidError();
  if (state.capture && state.capture.operation.source.baseImage !== allocation.target.baseImage)
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
