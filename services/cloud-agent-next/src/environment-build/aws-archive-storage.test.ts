import { describe, expect, it } from 'vitest';
import { ECS_TEST_CONFIG } from '../../test/fixtures/aws-ecs.js';
import {
  awsEcsArchiveBaseImage,
  decodeAwsArchiveBase,
  decodeAwsArchiveSnapshot,
  encodeAwsArchiveSnapshot,
  awsArchiveMatchesBase,
  awsArchiveObjectKey,
} from '../shared/aws-archive.js';
import type { RootfsArchiveDescriptor } from '../shared/rootfs-archive.js';
import {
  createAwsBuildArchiveStorage,
  type AwsBuildArchiveContext,
} from './aws-archive-storage.js';

const connectionId = '11111111-1111-4111-8111-111111111111';
const captureId = '55555555-5555-4555-8555-555555555555';
function fixture() {
  let context: AwsBuildArchiveContext = {
    environmentId: '22222222-2222-4222-8222-222222222222',
    buildId: '33333333-3333-4333-8333-333333333333',
    allocationId: '44444444-4444-4444-8444-444444444444',
    baseImage: awsEcsArchiveBaseImage(connectionId, ECS_TEST_CONFIG),
    deadlineAt: 100_000,
    state: 'preparing',
  };
  const descriptor: RootfsArchiveDescriptor = {
    format: 1,
    baseImage: context.baseImage,
    sha256: 'a'.repeat(64),
    size: 10240,
    expandedBytes: 111,
    fileCount: 2,
    deletedCount: 1,
  };
  let now = 1000;
  let stored: { size: number; sha256: string } | null = null;
  let onUpload = async () => {};
  let onHead = async () => {};
  const issued: Array<{ key: string; sha256: string; ttl: number }> = [];
  const api = createAwsBuildArchiveStorage({
    readContext: async () => structuredClone(context),
    serial: async operation => operation(),
    persist: archive => {
      context.archive = structuredClone(archive);
    },
    now: () => now,
    objects: {
      async prepareArchiveUpload(key, sha256, ttl) {
        // Persisted state must exist before a write capability can escape.
        expect(context.archive?.descriptor.sha256).toBe(sha256);
        issued.push({ key, sha256, ttl });
        await onUpload();
        return {
          url: 'https://synthetic.s3.amazonaws.com/upload',
          headers: { 'if-none-match': '*' },
        };
      },
      async inspectArchive(key) {
        expect(key).toBe(awsArchiveObjectKey(context));
        await onHead();
        return stored;
      },
    },
  });
  return {
    api,
    setNow: (value: number) => {
      now = value;
    },
    descriptor,
    issued,
    context: () => context,
    replace: (patch: Partial<AwsBuildArchiveContext>) => {
      context = { ...context, ...patch };
    },
    upload: (value = { size: descriptor.size, sha256: descriptor.sha256 }) => {
      stored = value;
    },
    onUpload: (hook: () => Promise<void>) => {
      onUpload = hook;
    },
    onHead: (hook: () => Promise<void>) => {
      onHead = hook;
    },
  };
}

describe('ECS immutable prepared archive', () => {
  it('reconciles a lost upload reply and returns the same captured descriptor', async () => {
    const f = fixture();
    await f.api.prepareUpload(f.descriptor);
    f.upload();
    // The PUT succeeded but its reply was lost. A new call gets the same key.
    await f.api.prepareUpload(f.descriptor);
    expect(f.issued[1]).toEqual(f.issued[0]);
    await f.api.completeUpload();
    await f.api.completeUpload();
    f.replace({ state: 'capturing', captureId });
    const first = await f.api.capture(captureId);
    expect(await f.api.capture(captureId)).toEqual(first);
    expect(first.status).toBe('stored');
    if (first.status !== 'stored') throw new Error('Expected archive');
    expect(decodeAwsArchiveSnapshot(first.snapshotId)).toEqual({
      format: 1,
      captureId,
      environmentId: f.context().environmentId,
      buildId: f.context().buildId,
      allocationId: f.context().allocationId,
      archive: f.descriptor,
    });
    expect(first.size).toBe(f.descriptor.size);
  });
  it('starts eligibility before a delayed verification and publication', async () => {
    const f = fixture();
    await f.api.prepareUpload(f.descriptor);
    f.upload();
    f.setNow(60_000);
    await f.api.completeUpload();
    f.replace({ state: 'capturing', captureId });
    f.setNow(70_000);
    expect(await f.api.capture(captureId)).toMatchObject({
      status: 'stored',
      capturedAt: 1000,
      durationMs: 59_000,
    });
  });
  it('never replaces a reserved object with another checksum or size', async () => {
    const f = fixture();
    await f.api.prepareUpload(f.descriptor);
    await expect(
      f.api.prepareUpload({ ...f.descriptor, sha256: 'b'.repeat(64) })
    ).rejects.toMatchObject({ code: 'archive_conflict' });
    await expect(f.api.prepareUpload({ ...f.descriptor, size: 20480 })).rejects.toMatchObject({
      code: 'archive_conflict',
    });
    expect(f.issued).toHaveLength(1);
  });
  it.each(['size', 'checksum', 'missing'])(
    'does not publish an archive with %s metadata',
    async change => {
      const f = fixture();
      await f.api.prepareUpload(f.descriptor);
      if (change !== 'missing')
        f.upload({
          size: change === 'size' ? 1 : f.descriptor.size,
          sha256: change === 'checksum' ? 'b'.repeat(64) : f.descriptor.sha256,
        });
      await expect(f.api.completeUpload()).rejects.toMatchObject({
        code: change === 'missing' ? 'archive_missing' : 'archive_invalid',
      });
      expect(f.context().archive?.verifiedAt).toBeUndefined();
      f.replace({ state: 'capturing', captureId });
      await expect(f.api.capture(captureId)).rejects.toMatchObject({ code: 'archive_unverified' });
    }
  );
  it.each(['cancel', 'replace', 'deadline'])(
    'rejects %s while the upload URL is signed',
    async change => {
      const f = fixture();
      f.onUpload(async () => {
        if (change === 'cancel') f.replace({ state: 'inactive' });
        if (change === 'replace')
          f.replace({ allocationId: '66666666-6666-4666-8666-666666666666' });
        if (change === 'deadline') f.replace({ deadlineAt: 999 });
      });
      await expect(f.api.prepareUpload(f.descriptor)).rejects.toMatchObject({
        code: 'build_inactive',
      });
    }
  );
  it('rejects cancellation while storage verification is in flight', async () => {
    const f = fixture();
    await f.api.prepareUpload(f.descriptor);
    f.upload();
    f.onHead(async () => {
      f.replace({ state: 'inactive' });
    });
    await expect(f.api.completeUpload()).rejects.toMatchObject({ code: 'build_inactive' });
    expect(f.context().archive?.verifiedAt).toBeUndefined();
  });
  it('refuses capture with a stable code when no archive was reserved', async () => {
    const f = fixture();
    f.replace({ state: 'capturing', captureId });
    await expect(f.api.capture(captureId)).rejects.toMatchObject({
      name: 'AwsBuildArchiveError',
      code: 'archive_missing',
    });
  });
  it('requires the coordinator capture ID and the exact pinned base', async () => {
    const f = fixture();
    await expect(
      f.api.prepareUpload({ ...f.descriptor, baseImage: 'foreign-image' })
    ).rejects.toMatchObject({ code: 'archive_invalid' });
    await f.api.prepareUpload(f.descriptor);
    f.upload();
    await f.api.completeUpload();
    f.replace({ state: 'capturing', captureId });
    await expect(f.api.capture('66666666-6666-4666-8666-666666666666')).rejects.toMatchObject({
      code: 'archive_conflict',
    });
  });
});

describe('AWS archive public identity', () => {
  it('contains no role credentials, external ID or proxy identity', () => {
    const base = awsEcsArchiveBaseImage(connectionId, ECS_TEST_CONFIG);
    const decoded = decodeAwsArchiveBase(base);
    expect(decoded).not.toHaveProperty('roleArn');
    expect(decoded).not.toHaveProperty('externalId');
    expect(decoded).not.toHaveProperty('proxy');
  });
  it.each(['connection', 'runtime', 'task-revision', 'bucket', 'account'])(
    'rejects another %s when restoring',
    change => {
      const f = fixture();
      const snapshot = {
        format: 1 as const,
        captureId,
        environmentId: f.context().environmentId,
        buildId: f.context().buildId,
        allocationId: f.context().allocationId,
        archive: f.descriptor,
      };
      const config = { ...ECS_TEST_CONFIG };
      if (change === 'runtime')
        config.runtimeImage = config.runtimeImage.replace(/[a-f0-9]{64}$/, 'd'.repeat(64));
      if (change === 'task-revision')
        config.taskDefinitionArn = config.taskDefinitionArn.replace(/:\d+$/, ':99');
      if (change === 'bucket') config.bucket += '-other';
      if (change === 'account') {
        config.taskDefinitionArn = config.taskDefinitionArn.replace(/\d{12}/, '999999999999');
        config.stackId = config.stackId.replace(/\d{12}/, '999999999999');
      }
      const current = awsEcsArchiveBaseImage(
        change === 'connection' ? '77777777-7777-4777-8777-777777777777' : connectionId,
        config
      );
      expect(awsArchiveMatchesBase(snapshot, f.context().baseImage)).toBe(true);
      expect(awsArchiveMatchesBase(snapshot, current)).toBe(false);
      const encoded = encodeAwsArchiveSnapshot(snapshot);
      expect(decodeAwsArchiveSnapshot(encoded)).toEqual(snapshot);
      expect(decodeAwsArchiveSnapshot(encoded + '/foreign')).toBeNull();
    }
  );
});
