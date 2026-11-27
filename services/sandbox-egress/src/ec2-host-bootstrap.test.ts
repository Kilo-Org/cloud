import { describe, expect, it } from 'vitest';
import { AWS_EC2_EGRESS_AUDIENCE, type AwsEc2HostLaunch } from '@kilocode/worker-utils/aws-egress';
import { createEc2BootSource } from './ec2-host-bootstrap.js';

const now = Date.UTC(2026, 10, 26);
const region = 'us-east-1';
const bucket = 'ec2-boot-test';
const accountId = '123456789012';
const instanceId = 'i-0123456789abcdef0';
const generation = '22222222-2222-4222-8222-222222222222';
const firstAllocation = '11111111-1111-4111-8111-111111111111';
const nextAllocation = '33333333-3333-4333-8333-333333333333';
const tokenPath = '/latest/api/token';
const allocationPath = '/latest/meta-data/tags/instance/KiloAllocation';
const imdsOrigin = 'http://169.254.169.254';

function document(allocationId: string, dataVolumeAction: AwsEc2HostLaunch['dataVolumeAction']) {
  const stackId = `arn:aws:cloudformation:${region}:${accountId}:stack/test/12345678-abcd`;
  const sandboxId = 'sbx_test';
  const claims = {
    type: 'aws_ec2_egress',
    aud: AWS_EC2_EGRESS_AUDIENCE,
    sandboxId,
    allocationId,
    generation,
    stackId,
    instanceId,
    exp: now / 1000 + 600,
  };
  const host: AwsEc2HostLaunch = {
    instanceId,
    dataVolumeId: 'vol-0123456789abcdef0',
    dataVolumeAction,
    allocationId,
    sandboxId,
    expiresAt: claims.exp * 1000,
    origin: 'https://worker.example',
    identity: { protocolVersion: 1, generation, stackId, secret: 'd'.repeat(64) },
    token: ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join(
      '.'
    ),
  };
  return { format: 1, deadlineAt: now + 60_000, argv: ['start-wrapper'], env: {}, host };
}

function fixture() {
  const fixture = {
    allocation: firstAllocation,
    launch: document(firstAllocation, 'initialize'),
    getStatus: 200,
    putStatus: 200,
    metadataPaths: [] as string[],
    objectRequests: [] as Request[],
  };
  const source = createEc2BootSource({
    region,
    bucket,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin !== imdsOrigin) {
        fixture.objectRequests.push(request);
        expect(request.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256 ')).toBe(true);
        expect(request.headers.get('x-amz-security-token')).toBe('test-instance-role-token');
        return request.method === 'GET'
          ? Response.json(fixture.launch, { status: fixture.getStatus })
          : new Response(null, { status: fixture.putStatus });
      }
      fixture.metadataPaths.push(url.pathname);
      if (url.pathname === tokenPath) {
        expect(request.method).toBe('PUT');
        expect(request.headers.get('x-aws-ec2-metadata-token-ttl-seconds')).toBe('60');
        return new Response('test-imds-token');
      }
      expect(request.method).toBe('GET');
      expect(request.headers.get('x-aws-ec2-metadata-token')).toBe('test-imds-token');
      switch (url.pathname) {
        case allocationPath:
          return new Response(fixture.allocation);
        case '/latest/dynamic/instance-identity/document':
          return Response.json({ accountId, region, instanceId });
        case '/latest/meta-data/tags/instance/KiloSandboxGeneration':
          return new Response(generation);
        case '/latest/meta-data/iam/security-credentials/':
          return new Response('test-role');
        case '/latest/meta-data/iam/security-credentials/test-role':
          return Response.json({
            Code: 'Success',
            AccessKeyId: 'TESTACCESSKEY12345678',
            SecretAccessKey: 'test-instance-role-secret',
            Token: 'test-instance-role-token',
            Expiration: new Date(Date.UTC(2099, 0, 1)).toISOString(),
          });
        default:
          throw new Error(`Unexpected metadata path ${url.pathname}`);
      }
    },
  });
  return { source, state: fixture };
}

function objectUrl(prefix: 'launch' | 'stopped', allocation: string) {
  const instanceArn = `arn:aws:ec2:${region}:${accountId}:instance/${instanceId}`;
  return `https://${bucket}.s3.${region}.amazonaws.com/kilo/${prefix}/${instanceArn}/${allocation}.json`;
}

describe('EC2 host S3 bootstrap', () => {
  it('loads its own launch grant and waits for a new allocation hint before reading S3 again', async () => {
    const { source, state } = fixture();
    const { metadataPaths, objectRequests } = state;
    const first = await source.readLaunch(undefined, now);
    expect(first?.workload.argv).toEqual(['start-wrapper']);
    expect(first?.host).toEqual(state.launch.host);
    expect(objectRequests.map(request => request.url)).toEqual([
      objectUrl('launch', firstAllocation),
    ]);

    metadataPaths.length = 0;
    await expect(source.readLaunch(firstAllocation, now)).resolves.toBeNull();
    expect(metadataPaths).toEqual([tokenPath, allocationPath]);
    expect(objectRequests).toHaveLength(1);

    state.allocation = nextAllocation;
    await expect(source.readLaunch(firstAllocation, now)).rejects.toThrow(
      'EC2 boot binding mismatch'
    );
    expect(objectRequests[1]?.url).toBe(objectUrl('launch', nextAllocation));

    state.launch = document(nextAllocation, 'resume');
    await expect(source.readLaunch(firstAllocation, now)).resolves.toMatchObject({
      host: { allocationId: nextAllocation, dataVolumeAction: 'resume' },
    });
    expect(objectRequests[2]?.url).toBe(objectUrl('launch', nextAllocation));
  });

  it.each([403, 404])('waits when the active launch object returns HTTP %d', async status => {
    const { source, state } = fixture();
    state.getStatus = status;
    await expect(source.readLaunch(undefined, now)).resolves.toBeNull();
  });

  it('refuses a document for a different instance at its own object key', async () => {
    const { source, state } = fixture();
    state.launch.host.instanceId = 'i-0123456789abcdef1';
    await expect(source.readLaunch(undefined, now)).rejects.toThrow('EC2 boot binding mismatch');
  });

  it('writes an idempotent stop marker and rejects a stale allocation before another S3 write', async () => {
    const { source, state } = fixture();
    const { objectRequests } = state;
    const host = state.launch.host;
    await source.attestCleanStop(host);
    expect(objectRequests[0]?.url).toBe(objectUrl('stopped', firstAllocation));
    expect(objectRequests[0]?.method).toBe('PUT');
    expect(objectRequests[0]?.headers.get('if-none-match')).toBe('*');
    expect(await objectRequests[0]?.text()).toBe('{}');

    state.putStatus = 412;
    await expect(source.attestCleanStop(host)).resolves.toBeUndefined();
    state.allocation = nextAllocation;
    await expect(source.attestCleanStop(host)).rejects.toThrow('EC2 stop binding mismatch');
    expect(objectRequests).toHaveLength(2);
  });
});
