import { withTimeout } from '@kilocode/worker-utils';
import type { AwsByocConfiguration } from '@kilocode/worker-utils/aws-byoc';
import type { AwsEcsByocConfiguration } from '@kilocode/worker-utils/aws-ecs';
import type { AwsObjectStore } from '../agent-sandbox/aws/object-store.js';
import {
  awsArchiveBaseImage,
  awsEcsArchiveBaseImage,
  awsArchiveMatchesBase,
  awsArchiveObjectKey,
  decodeAwsArchiveSnapshot,
} from '../shared/aws-archive.js';
import { renderAwsArchiveRestore } from './aws-archive-bootstrap.js';
import {
  ProviderSnapshotCreationError,
  type ProviderSnapshotStart,
  type ProviderStartup,
} from './provider.js';

type Target =
  | { provider: 'aws'; configuration: AwsByocConfiguration }
  | { provider: 'aws-ecs'; configuration: AwsEcsByocConfiguration };

/** The environment coordinator owns authorization and age. Both AWS engines share storage and restore admission. */
export async function prepareAwsSnapshotStartup(
  input: Target & {
    connectionId: string;
    currentConfiguration(): Promise<AwsByocConfiguration | AwsEcsByocConfiguration>;
    objects: Pick<AwsObjectStore, 'inspectArchive' | 'downloadUrl'>;
    snapshot: ProviderSnapshotStart;
    startup: ProviderStartup;
    workerUrl: string | undefined;
    sandboxId: string;
    allocationId: string;
    deadlineAt: number;
    now?: () => number;
  }
): Promise<ProviderStartup> {
  const now = input.now ?? Date.now;
  function budget() {
    const remaining = Math.min(5000, input.deadlineAt - now());
    if (!Number.isSafeInteger(input.deadlineAt) || remaining <= 0)
      throw new ProviderSnapshotCreationError('transient');
    return remaining;
  }
  budget();
  if (!input.workerUrl) throw new ProviderSnapshotCreationError('transient');
  if (input.snapshot.provider !== input.provider)
    throw new ProviderSnapshotCreationError('provenance');
  const base =
    input.provider === 'aws'
      ? awsArchiveBaseImage(input.connectionId, input.configuration)
      : awsEcsArchiveBaseImage(input.connectionId, input.configuration);
  const descriptor = decodeAwsArchiveSnapshot(input.snapshot.snapshotId);
  if (!descriptor || input.snapshot.baseImage !== base || !awsArchiveMatchesBase(descriptor, base))
    throw new ProviderSnapshotCreationError('image_mismatch');
  const current = await withTimeout(
    input.currentConfiguration(),
    budget(),
    'AWS snapshot connection lookup timed out'
  );
  if (JSON.stringify(current) !== JSON.stringify(input.configuration))
    throw new ProviderSnapshotCreationError('image_mismatch');
  const key = awsArchiveObjectKey(descriptor);
  const object = await withTimeout(
    input.objects.inspectArchive(key),
    budget(),
    'AWS snapshot metadata lookup timed out'
  );
  if (!object) throw new ProviderSnapshotCreationError('missing');
  if (object.size !== descriptor.archive.size || object.sha256 !== descriptor.archive.sha256)
    throw new ProviderSnapshotCreationError('provenance');
  budget();
  const seconds = Math.min(600, Math.ceil((input.deadlineAt - now()) / 1000));
  const downloadUrl = await input.objects.downloadUrl(key, seconds);
  budget();
  return {
    ...input.startup,
    command: renderAwsArchiveRestore({
      ...input,
      workerUrl: input.workerUrl,
      snapshotId: input.snapshot.snapshotId,
      downloadUrl,
      reportUrl: new URL(
        `/sandbox-control/${encodeURIComponent(input.sandboxId)}/startup-failure`,
        input.workerUrl
      ).href,
      command: input.startup.command,
      filesystemRoot: '/',
    }),
  };
}
