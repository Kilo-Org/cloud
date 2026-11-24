import { awsEcsByocConfigurationSchema } from '@kilocode/worker-utils/aws-ecs';
import { describe, expect, it } from 'vitest';
import { ECS_TEST_CONFIG } from '../../test/fixtures/aws-ecs.js';
import { renderAwsArchiveRestore } from './aws-archive-bootstrap.js';
import {
  awsEcsArchiveBaseImage,
  decodeAwsArchiveBase,
  encodeAwsArchiveSnapshot,
  decodeAwsArchiveSnapshot,
  awsArchiveObjectKey,
} from '../shared/aws-archive.js';

const connectionId = '11111111-1111-4111-8111-111111111111';
const identity = {
  format: 1 as const,
  captureId: '22222222-2222-4222-8222-222222222222',
  environmentId: '33333333-3333-4333-8333-333333333333',
  buildId: '44444444-4444-4444-8444-444444444444',
  allocationId: '55555555-5555-4555-8555-555555555555',
};
function restoreInput() {
  const baseImage = awsEcsArchiveBaseImage(connectionId, ECS_TEST_CONFIG);
  const snapshot = {
    ...identity,
    archive: {
      format: 1 as const,
      baseImage,
      sha256: 'a'.repeat(64),
      size: 10240,
      expandedBytes: 100,
      fileCount: 1,
      deletedCount: 0,
    },
  };
  return {
    configuration: ECS_TEST_CONFIG,
    connectionId,
    snapshotId: encodeAwsArchiveSnapshot(snapshot),
    downloadUrl: `https://customer-artifacts.s3.us-east-1.amazonaws.com/${awsArchiveObjectKey(identity)}?synthetic=fixture`,
    reportUrl: 'https://worker.example.com/sandbox-control/sbx-test/startup-failure',
    workerUrl: 'https://worker.example.com',
    allocationId: identity.allocationId,
    deadlineAt: Date.now() + 30_000,
    filesystemRoot: '/tmp/synthetic-archive-root',
    command: { argv: ['/usr/local/bin/node', '/opt/kilo/start.mjs'] },
  };
}
describe('shared AWS archives with exact engine identity', () => {
  it('refuses a retired MicroVM base identity', () => {
    const retired =
      'aws-image:v1:eyJjb25uZWN0aW9uSWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJyZWdpb24iOiJ1cy1lYXN0LTEiLCJidWNrZXQiOiJjdXN0b21lci1hcnRpZmFjdHMiLCJzdGFja0lkIjoiYXJuOmF3czpjbG91ZGZvcm1hdGlvbjp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOnN0YWNrL2N1c3RvbWVyLzEyMzQ1Njc4LWFiY2QiLCJpbWFnZUlkZW50aWZpZXIiOiJhcm46YXdzOmxhbWJkYTp1cy1lYXN0LTE6MTIzNDU2Nzg5MDEyOm1pY3Jvdm0taW1hZ2U6a2lsbyIsImltYWdlVmVyc2lvbiI6IjEuMCJ9';
    expect(decodeAwsArchiveBase(retired)).toBeNull();
    const ownBase = decodeAwsArchiveSnapshot(restoreInput().snapshotId)!.archive.baseImage;
    // The retired prefix cannot make an ECS identity valid.
    expect(decodeAwsArchiveBase(ownBase.replace(/^aws-ecs-image:v1:/, 'aws-image:v1:'))).toBeNull();
  });
  it('round-trips through shared capture and restore rendering', () => {
    const input = restoreInput();
    const snapshot = decodeAwsArchiveSnapshot(input.snapshotId);
    expect(snapshot).not.toBeNull();
    expect(encodeAwsArchiveSnapshot(snapshot!)).toBe(input.snapshotId);
    expect(renderAwsArchiveRestore(input).argv[0]).toBe('/usr/local/bin/node');
    expect(JSON.stringify(decodeAwsArchiveBase(snapshot!.archive.baseImage))).not.toContain(
      'externalId'
    );
  });
  it.each(['connection', 'bucket', 'stack', 'runtime-digest', 'task-revision', 'region'])(
    'rejects changed ECS %s before producing a startup command',
    change => {
      const value = { ...restoreInput(), configuration: { ...ECS_TEST_CONFIG } };
      if (change === 'connection') value.connectionId = '66666666-6666-4666-8666-666666666666';
      if (change === 'bucket') value.configuration.bucket += '-other';
      if (change === 'stack')
        value.configuration.stackId = value.configuration.stackId.replace('/customer/', '/other/');
      if (change === 'runtime-digest')
        value.configuration.runtimeImage = value.configuration.runtimeImage.replace(
          'c'.repeat(64),
          'd'.repeat(64)
        );
      if (change === 'task-revision')
        value.configuration.taskDefinitionArn = value.configuration.taskDefinitionArn.replace(
          /:1$/,
          ':2'
        );
      if (change === 'region') Object.assign(value.configuration, { region: 'us-west-2' });
      else expect(awsEcsByocConfigurationSchema.safeParse(value.configuration).success).toBe(true);
      expect(() => renderAwsArchiveRestore(value)).toThrow();
    }
  );
  it('rejects foreign task ownership while permitting the approved publisher runtime', () => {
    const base = awsEcsArchiveBaseImage(connectionId, ECS_TEST_CONFIG);
    expect(decodeAwsArchiveBase(base)).toMatchObject({
      provider: 'aws-ecs',
      runtimeImage: ECS_TEST_CONFIG.runtimeImage,
    });
    expect(() =>
      awsEcsArchiveBaseImage(connectionId, {
        ...ECS_TEST_CONFIG,
        taskDefinitionArn: ECS_TEST_CONFIG.taskDefinitionArn.replace(
          '123456789012',
          '888888888888'
        ),
      })
    ).toThrow();
  });
  it('refuses a configuration without the ECS fields', () => {
    const { runtimeImage: _runtimeImage, ...configuration } = ECS_TEST_CONFIG;
    expect(() => renderAwsArchiveRestore({ ...restoreInput(), configuration } as never)).toThrow();
  });
});
