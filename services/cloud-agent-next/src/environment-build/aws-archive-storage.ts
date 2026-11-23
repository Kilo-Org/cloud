import { z } from 'zod';
import type { AwsObjectStore } from '../agent-sandbox/aws/object-store.js';
import type { NativeCaptureResult } from '../sandbox-containers/native-capture.js';
import {
  awsArchiveObjectKey,
  decodeAwsArchiveBase,
  encodeAwsArchiveSnapshot,
} from '../shared/aws-archive.js';
import {
  rootfsArchiveDescriptorSchema,
  type RootfsArchiveDescriptor,
} from '../shared/rootfs-archive.js';

export const awsBuildArchiveStateSchema = z
  .object({
    descriptor: rootfsArchiveDescriptorSchema,
    reservedAt: z.number().int().nonnegative(),
    verifiedAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AwsBuildArchiveState = z.infer<typeof awsBuildArchiveStateSchema>;
export type AwsBuildArchiveContext = {
  environmentId: string;
  buildId: string;
  allocationId: string;
  baseImage: string;
  deadlineAt: number;
  state: 'preparing' | 'capturing' | 'inactive';
  captureId?: string;
  archive?: AwsBuildArchiveState;
};
export class AwsBuildArchiveError extends Error {
  constructor(
    readonly code:
      | 'build_inactive'
      | 'archive_invalid'
      | 'archive_conflict'
      | 'archive_missing'
      | 'archive_unverified'
  ) {
    super(code);
    this.name = 'AwsBuildArchiveError';
  }
}
function sameBuild(left: AwsBuildArchiveContext, right: AwsBuildArchiveContext) {
  return (
    left.environmentId === right.environmentId &&
    left.buildId === right.buildId &&
    left.allocationId === right.allocationId &&
    left.baseImage === right.baseImage &&
    left.deadlineAt === right.deadlineAt
  );
}
function sameDescriptor(left: RootfsArchiveDescriptor, right: RootfsArchiveDescriptor) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** One immutable archive per build allocation. The coordinator supplies durable state and lifecycle fences. */
export function createAwsBuildArchiveStorage(deps: {
  readContext(): Promise<AwsBuildArchiveContext>;
  serial<T>(operation: () => Promise<T>): Promise<T>;
  persist(archive: AwsBuildArchiveState): void;
  objects: Pick<AwsObjectStore, 'prepareArchiveUpload' | 'inspectArchive'>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  async function current(initial: AwsBuildArchiveContext, state: 'preparing' | 'capturing') {
    const value = await deps.readContext();
    if (!sameBuild(value, initial) || value.state !== state || value.deadlineAt <= now())
      throw new AwsBuildArchiveError('build_inactive');
    return value;
  }
  async function preparing() {
    const value = await deps.readContext();
    if (
      value.state !== 'preparing' ||
      value.deadlineAt <= now() ||
      !decodeAwsArchiveBase(value.baseImage)
    )
      throw new AwsBuildArchiveError('build_inactive');
    return value;
  }
  return {
    async prepareUpload(value: unknown) {
      const descriptor = rootfsArchiveDescriptorSchema.safeParse(value);
      if (!descriptor.success) throw new AwsBuildArchiveError('archive_invalid');
      const initial = await deps.serial(async () => {
        const context = await preparing();
        if (context.baseImage !== descriptor.data.baseImage)
          throw new AwsBuildArchiveError('archive_invalid');
        if (context.archive && !sameDescriptor(context.archive.descriptor, descriptor.data))
          throw new AwsBuildArchiveError('archive_conflict');
        // Reserve checksum and size before issuing a capability. Lost replies reuse this intent and key.
        if (!context.archive) deps.persist({ descriptor: descriptor.data, reservedAt: now() });
        return context;
      });
      const ttl = Math.min(600, Math.floor((initial.deadlineAt - now()) / 1000));
      if (ttl < 1) throw new AwsBuildArchiveError('build_inactive');
      const upload = await deps.objects.prepareArchiveUpload(
        awsArchiveObjectKey(initial),
        descriptor.data.sha256,
        ttl
      );
      await deps.serial(() => current(initial, 'preparing'));
      return upload;
    },
    async completeUpload(): Promise<void> {
      const initial = await deps.serial(preparing);
      if (!initial.archive) throw new AwsBuildArchiveError('archive_missing');
      const expectedDescriptor = initial.archive.descriptor;
      const object = await deps.objects.inspectArchive(awsArchiveObjectKey(initial));
      if (!object) throw new AwsBuildArchiveError('archive_missing');
      if (
        object.size !== initial.archive.descriptor.size ||
        object.sha256 !== initial.archive.descriptor.sha256
      )
        throw new AwsBuildArchiveError('archive_invalid');
      await deps.serial(async () => {
        const context = await current(initial, 'preparing');
        if (!context.archive || !sameDescriptor(context.archive.descriptor, expectedDescriptor))
          throw new AwsBuildArchiveError('archive_conflict');
        if (context.archive.verifiedAt === undefined)
          deps.persist({ ...context.archive, verifiedAt: now() });
      });
    },
    async capture(captureId: string): Promise<NativeCaptureResult> {
      return deps.serial(async () => {
        const context = await deps.readContext();
        await current(context, 'capturing');
        if (context.captureId !== captureId) throw new AwsBuildArchiveError('archive_conflict');
        if (!context.archive) throw new AwsBuildArchiveError('archive_missing');
        const parsed = awsBuildArchiveStateSchema.safeParse(context.archive);
        if (!parsed.success) throw new AwsBuildArchiveError('archive_invalid');
        const archive = parsed.data;
        const verifiedAt = archive.verifiedAt;
        if (verifiedAt === undefined) throw new AwsBuildArchiveError('archive_unverified');
        if (archive.descriptor.baseImage !== context.baseImage)
          throw new AwsBuildArchiveError('archive_invalid');
        return {
          status: 'stored',
          snapshotId: encodeAwsArchiveSnapshot({
            format: 1,
            captureId,
            environmentId: context.environmentId,
            buildId: context.buildId,
            allocationId: context.allocationId,
            archive: archive.descriptor,
          }),
          baseImage: context.baseImage,
          capturedAt: verifiedAt,
          size: archive.descriptor.size,
          durationMs: Math.max(0, verifiedAt - archive.reservedAt),
        };
      });
    },
  };
}
