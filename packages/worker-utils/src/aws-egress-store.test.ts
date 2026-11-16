import { describe, expect, it, vi } from 'vitest';
import { createAwsEgressMetadataReader, AwsEgressMetadataError } from './aws-egress-store';
import { AWS_EGRESS_PUBLIC_KEY, AWS_EGRESS_SHARED_KEY } from './aws-egress';
import { sha256Hex } from './sha256';

const stackId = 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd';
const generation = '22222222-2222-4222-8222-222222222222';
const caCertificate = 'c'.repeat(128);
async function fixture(
  publicOverride: Record<string, unknown> = {},
  sharedOverride: Record<string, unknown> = {}
) {
  const deployment = {
    protocolVersion: 1,
    generation,
    stackId,
    hostname: 'proxy.kilo.internal',
    port: 3128,
    caCertificate,
    caFingerprint: await sha256Hex(caCertificate),
    expiresAt: '2027-01-01T00:00:00.000Z',
    ...publicOverride,
  };
  const identity = {
    protocolVersion: 1,
    generation,
    stackId,
    secret: 'a'.repeat(64),
    ...sharedOverride,
  };
  const fetch = vi.fn(async (request: Request) => {
    const key = new URL(request.url).pathname.slice(1);
    if (key === AWS_EGRESS_PUBLIC_KEY) return Response.json(deployment);
    if (key === AWS_EGRESS_SHARED_KEY) return Response.json(identity);
    throw new Error('Attempted private proxy access');
  });
  const read = createAwsEgressMetadataReader({
    credentials: { accessKeyId: 'ASIATEST000000000000', secretAccessKey: 'test-secret' },
    region: 'us-east-1',
    bucket: 'customer-artifacts',
    stackId,
    fetch,
    now: () => Date.parse('2026-11-15T00:00:00.000Z'),
  });
  return { read, fetch, deployment, identity };
}
describe('AWS proxy metadata scope', () => {
  it('reads only matching public and shared documents', async () => {
    const f = await fixture();
    await expect(f.read()).resolves.toEqual({ deployment: f.deployment, identity: f.identity });
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    { caFingerprint: 'f'.repeat(64) },
    { protocolVersion: 2 },
    { stackId: 'arn:aws:cloudformation:us-east-1:999999999999:stack/other/12345678-abcd' },
    { expiresAt: '2026-11-14T00:00:00.000Z' },
  ])('refuses changed or expired deployment metadata: %j', async override => {
    const f = await fixture(override);
    await expect(f.read()).rejects.toBeInstanceOf(AwsEgressMetadataError);
  });
  it('refuses mismatched generations during partial publication', async () => {
    const f = await fixture({}, { generation: '33333333-3333-4333-8333-333333333333' });
    await expect(f.read()).rejects.toBeInstanceOf(AwsEgressMetadataError);
  });
});
