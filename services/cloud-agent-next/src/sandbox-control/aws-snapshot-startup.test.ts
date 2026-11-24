import { describe, expect, it, vi } from 'vitest';
import { ecsProviderFixture, ECS_TEST_CONFIG } from '../../test/fixtures/aws-ecs.js';
import {
  awsEcsArchiveBaseImage,
  encodeAwsArchiveSnapshot,
  awsArchiveObjectKey,
} from '../shared/aws-archive.js';
import { prepareAwsSnapshotStartup } from './aws-snapshot-startup.js';
import { ProviderSnapshotCreationError, type ProviderStartup } from './provider.js';

const connectionId = '11111111-1111-4111-8111-111111111111';
const identity = {
  format: 1 as const,
  captureId: '22222222-2222-4222-8222-222222222222',
  environmentId: '33333333-3333-4333-8333-333333333333',
  buildId: '44444444-4444-4444-8444-444444444444',
  allocationId: '55555555-5555-4555-8555-555555555555',
};
const proxy = new URL('http://proxy.internal:3128/');
proxy.username = 'kilo';
proxy.password = 'synthetic';
const startup = {
  command: { argv: ['/usr/local/bin/node', '/fresh-runtime.mjs'] },
  env: {
    HTTPS_PROXY: proxy.href,
    KILO_AWS_EGRESS_CA_CERTIFICATE: 'synthetic-public-ca',
    SANDBOX_CONTROL_CREDENTIAL: 'synthetic-launch-only',
  },
};
function fixture() {
  const baseImage = awsEcsArchiveBaseImage(connectionId, ECS_TEST_CONFIG);
  const archive = {
    format: 1 as const,
    baseImage,
    sha256: 'a'.repeat(64),
    size: 10240,
    expandedBytes: 0,
    fileCount: 0,
    deletedCount: 0,
  };
  const snapshot = {
    provider: 'aws-ecs' as 'vercel' | 'aws-ecs',
    baseImage,
    snapshotId: encodeAwsArchiveSnapshot({ ...identity, archive }),
  };
  const inspectArchive = vi.fn(
    async (_key: string): Promise<{ size: number; sha256: string } | null> => ({
      size: archive.size,
      sha256: archive.sha256,
    })
  );
  const downloadUrl = vi.fn(
    async (key: string, _seconds: number) =>
      `https://customer-artifacts.s3.us-east-1.amazonaws.com/${key}?synthetic-signature`
  );
  const currentConfiguration = vi.fn(async () => ECS_TEST_CONFIG);
  return {
    input: {
      configuration: ECS_TEST_CONFIG,
      connectionId,
      snapshot,
      startup,
      workerUrl: 'https://worker.test',
      sandboxId: 'ses-abcdef',
      allocationId: identity.allocationId,
      deadlineAt: 31_000,
      now: () => 1000,
      currentConfiguration,
      objects: { inspectArchive, downloadUrl },
    },
    inspectArchive,
    downloadUrl,
    currentConfiguration,
  };
}

describe('ECS session archive admission', () => {
  it('checks pinned metadata and restores before the fresh runtime with the proxy environment intact', async () => {
    const f = fixture();
    const result = await prepareAwsSnapshotStartup(f.input);
    expect(f.inspectArchive).toHaveBeenCalledWith(awsArchiveObjectKey(identity));
    expect(f.downloadUrl).toHaveBeenCalledWith(awsArchiveObjectKey(identity), 30);
    expect(result.env).toEqual(startup.env);
    const rendered = JSON.parse(result.command.argv[4]) as {
      argv: string[];
      root: string;
      deadlineAt: number;
    };
    expect(rendered).toMatchObject({ argv: startup.command.argv, root: '/', deadlineAt: 31_000 });
    expect(result.command.argv[3]).toContain('process.execve(C.argv[0], C.argv, environment)');
  });
  it.each([
    'provider',
    'connection',
    'base',
    'current-connection',
    'missing',
    'checksum',
    'size',
    'deadline',
  ])('rejects %s before signing a download', async change => {
    const f = fixture();
    if (change === 'provider') f.input.snapshot.provider = 'vercel';
    if (change === 'connection') f.input.connectionId = '66666666-6666-4666-8666-666666666666';
    if (change === 'base') f.input.snapshot.baseImage = 'other-base';
    if (change === 'current-connection')
      f.currentConfiguration.mockResolvedValue({ ...f.input.configuration, externalId: 'changed' });
    if (change === 'missing') f.inspectArchive.mockResolvedValue(null);
    if (change === 'checksum')
      f.inspectArchive.mockResolvedValue({ size: 10240, sha256: 'b'.repeat(64) });
    if (change === 'size') f.inspectArchive.mockResolvedValue({ size: 1, sha256: 'a'.repeat(64) });
    if (change === 'deadline') f.input.deadlineAt = 1000;
    await expect(prepareAwsSnapshotStartup(f.input)).rejects.toThrow();
    expect(f.downloadUrl).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'recovers the persisted snapshot source without preparing twice (lost reply: %s)',
    async lostReply => {
      const f = ecsProviderFixture();
      const prepare = vi.fn(async (value: ProviderStartup) => ({
        ...value,
        command: { argv: ['/restored-runtime'] },
      }));
      f.setSnapshotPreparation(prepare);
      const first = f.adapter();
      const created = await first.create({ intentId: 'allocation-1', createdAt: 10_000 });
      if (!('providerRef' in created)) throw new Error('Missing test reference');
      const options = { snapshot: fixture().input.snapshot, deadlineAt: 31_000 };
      if (lostReply) f.loseNextReply();
      if (lostReply)
        await expect(first.launch(created.providerRef, startup, options)).rejects.toThrow();
      else
        expect(await first.launch(created.providerRef, startup, options)).toEqual({
          startSource: 'repository',
        });
      expect(f.operations.get('allocation-1')).toHaveProperty('startSource', 'repository');
      expect(await f.adapter().reconcileLaunch(created.providerRef)).toEqual({
        startSource: 'repository',
      });
      expect(prepare).toHaveBeenCalledOnce();
      expect(f.signedUrls()).toBe(1);
      if (lostReply) expect(f.submitted[1]).toEqual(f.submitted[0]);
    }
  );

  it('does not issue Run after cancellation during archive preparation', async () => {
    const f = ecsProviderFixture();
    const first = f.adapter();
    const created = await first.create({ intentId: 'allocation-1', createdAt: 10_000 });
    if (!('providerRef' in created)) throw new Error('Missing test reference');
    f.setSnapshotPreparation(async value => {
      await f.adapter().stop(created.providerRef);
      return value;
    });
    await expect(
      f.adapter().launch(created.providerRef, startup, { snapshot: fixture().input.snapshot })
    ).rejects.toThrow('stopping');
    expect(f.submitted).toHaveLength(0);
    expect(await f.adapter().stop(created.providerRef)).toBe('terminal');
    expect(f.documents.size).toBe(0);
  });

  it('returns a permanent missing-archive result without an image start', async () => {
    const f = ecsProviderFixture();
    f.setSnapshotPreparation(async () => {
      throw new ProviderSnapshotCreationError('missing');
    });
    const adapter = f.adapter();
    const created = await adapter.create({ intentId: 'allocation-1', createdAt: 10_000 });
    if (!('providerRef' in created)) throw new Error('Missing test reference');
    expect(
      await adapter.launch(created.providerRef, startup, {
        snapshot: fixture().input.snapshot,
      })
    ).toEqual({
      startSource: 'repository',
      snapshotFailed: true,
      snapshotFailureReason: 'missing',
    });
    expect(f.submitted).toHaveLength(0);
  });
});
