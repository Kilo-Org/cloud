import {
  awsEc2Ref,
  awsEc2WorkspaceSchema,
  type AwsEc2WorkspaceStorage,
} from '../../sandbox-control/aws-ec2-lifecycle.js';
import type { AwsEc2SnapshotStorage } from '../../sandbox-control/aws-ec2-snapshot.js';

const WORKSPACE_KEY = 'aws-ec2-workspace';
const CAPTURE_PREFIX = 'aws-ec2-capture:';
type Storage = Pick<DurableObjectStorage, 'get' | 'transaction' | 'delete'>;

export function awsEc2WorkspaceStorage(storage: Storage): AwsEc2WorkspaceStorage {
  return {
    get: () => storage.get(WORKSPACE_KEY),
    put: workspace => storage.transaction(transaction => transaction.put(WORKSPACE_KEY, workspace)),
    async delete() {
      await storage.delete(WORKSPACE_KEY);
    },
  };
}

export function awsEc2CaptureStorage(storage: Storage): AwsEc2SnapshotStorage {
  return {
    get: id => storage.get(CAPTURE_PREFIX + id),
    update: (id, transition) =>
      storage.transaction(async transaction => {
        const key = CAPTURE_PREFIX + id;
        const next = transition(await transaction.get(key));
        await transaction.put(key, next);
      }),
    async delete(id) {
      await storage.delete(CAPTURE_PREFIX + id);
    },
  };
}

export async function readAwsEc2EgressWorkspace(storage: Storage, ref: string | null) {
  if (!ref?.startsWith('aws-ec2/')) return null;
  const workspace = awsEc2WorkspaceSchema.safeParse(await storage.get(WORKSPACE_KEY)).data;
  return workspace && awsEc2Ref(workspace) === ref ? workspace : null;
}
