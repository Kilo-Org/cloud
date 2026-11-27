import { describe, expect, it, vi } from 'vitest';
import type { AwsEgressPolicy } from '@kilocode/worker-utils/aws-egress';
import {
  createHostControlPlaneClient,
  egressCredentialKey,
  parseEgressCredential,
} from './control-plane.js';

const stackId = 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd';
const generation = '22222222-2222-4222-8222-222222222222';
const identity = { protocolVersion: 1 as const, generation, stackId, secret: 'b'.repeat(64) };
const claims = {
  type: 'aws_ec2_egress',
  aud: 'kilo-aws-ec2-egress',
  sandboxId: 'sbx_aws_test',
  allocationId: '11111111-1111-4111-8111-111111111111',
  instanceId: 'i-1234567890abcdef0',
  generation,
  stackId,
  exp: 1000,
};
// The proxy does not possess the Worker's signing key. These fixtures test response binding, not signature verification.
const token = [
  'header',
  Buffer.from(JSON.stringify(claims)).toString('base64url'),
  'signature',
].join('.');
const policy: AwsEgressPolicy = {
  protocolVersion: 1,
  generation,
  stackId,
  sandboxId: claims.sandboxId,
  allocationId: claims.allocationId,
  allocationRef: 'allocation-1',
  validUntil: 40_000,
  audit: true,
  interceptedHosts: ['github.com'],
  allowlist: ['github.com', 'worker.example'],
};
const signal = () => new AbortController().signal;
function client(fetch = async (_request: Request) => Response.json(policy)) {
  return createHostControlPlaneClient({
    origin: 'https://worker.example',
    sandboxId: claims.sandboxId,
    allocationId: claims.allocationId,
    instanceId: claims.instanceId,
    identity,
    fetch,
    now: () => 10_000,
  });
}

describe('proxy control-plane boundary', () => {
  it('accepts only matching deployment, allocation and bounded policy responses', async () => {
    const transport = vi.fn(async (request: Request) => {
      expect(request.headers.get('x-kilo-egress-identity')).toBe(identity.secret);
      expect(request.headers.get('x-kilo-egress-credential')).toBe(token);
      expect(request.redirect).toBe('manual');
      expect(request.url).toBe('https://worker.example/aws-egress/sbx_aws_test/policy');
      return Response.json(policy);
    });
    await expect(client(transport).loadPolicy(token, signal())).resolves.toEqual(policy);
  });
  it.each([
    { generation: '33333333-3333-4333-8333-333333333333' },
    { allocationId: '33333333-3333-4333-8333-333333333333' },
    { sandboxId: 'sbx_other' },
    { validUntil: 10_000 },
    { validUntil: 45_001 },
    { interceptedHosts: ['custom.gitlab.example'] },
    { protocolVersion: 2 },
  ])('refuses foreign or stale policy evidence: %j', async override => {
    await expect(
      client(async () => Response.json({ ...policy, ...override })).loadPolicy(token, signal())
    ).rejects.toThrow('control plane unavailable');
  });
  it('accepts bounded Worker clock skew while preserving the local 30-second limit', async () => {
    const result = await client(async () =>
      Response.json({ ...policy, validUntil: 40_100 })
    ).loadPolicy(token, signal());
    expect(result.validUntil).toBe(40_000);
  });
  it('does not extend local freshness by the request latency', async () => {
    let now = 10_000;
    const transport = createHostControlPlaneClient({
      origin: 'https://worker.example',
      sandboxId: claims.sandboxId,
      allocationId: claims.allocationId,
      instanceId: claims.instanceId,
      identity,
      now: () => now,
      fetch: async () => {
        now += 5_000;
        return Response.json({ ...policy, validUntil: now + 30_000 });
      },
    });
    expect((await transport.loadPolicy(token, signal())).validUntil).toBe(40_000);
  });
  it('does not turn a refresh failure into an empty interception policy', async () => {
    await expect(
      client(async () => new Response(null, { status: 503 })).loadPolicy(token, signal())
    ).rejects.toThrow('control plane unavailable');
  });
  it('keys cached authorization on the entire credential proof', () => {
    expect(egressCredentialKey(token)).not.toBe(
      egressCredentialKey(token.replace('signature', 'forged'))
    );
  });
  it('streams SCM bodies, strips transport headers and preserves upstream rejection', async () => {
    let produced = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced++ === 3) controller.close();
        else controller.enqueue(new Uint8Array(65_536).fill(7));
      },
    });
    const options: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      body,
      duplex: 'half',
      headers: {
        authorization: 'Bearer scoped-handle',
        'proxy-authorization': 'do-not-forward',
        'x-kilo-egress-identity': 'spoofed',
        connection: 'x-remove',
        'x-remove': 'do-not-forward',
      },
    };
    const request = new Request('https://github.com/owner/repo.git/git-upload-pack', options);
    const transport = vi.fn(async (forwarded: Request) => {
      expect(produced).toBeLessThanOrEqual(1);
      expect(forwarded.headers.get('proxy-authorization')).toBeNull();
      expect(forwarded.headers.get('x-remove')).toBeNull();
      expect(forwarded.headers.get('authorization')).toBe('Bearer scoped-handle');
      expect(forwarded.headers.get('x-kilo-egress-identity')).toBe(identity.secret);
      expect(forwarded.headers.get('x-kilo-egress-target')).toBe(request.url);
      const received = new Uint8Array(await forwarded.arrayBuffer());
      expect(received.byteLength).toBe(3 * 65_536);
      expect(received.every(byte => byte === 7)).toBe(true);
      return new Response('denied', { status: 403 });
    });
    const response = await client(transport).forwardScm(token, request, signal());
    expect(response.status).toBe(403);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not expose arbitrary transport errors or proxy identity values', async () => {
    try {
      await client(async () => {
        throw new Error(identity.secret + token);
      }).loadPolicy(token, signal());
    } catch (error) {
      expect(String(error)).not.toContain(identity.secret);
      expect(String(error)).not.toContain(token);
      return;
    }
    throw new Error('Expected rejection');
  });
});

describe('EC2 build proxy route', () => {
  const environmentId = '33333333-3333-4333-8333-333333333333';
  const buildId = '44444444-4444-4444-8444-444444444444';
  const buildClaims = {
    ...claims,
    build: {
      environmentId,
      buildId,
      actorUserId: 'oauth/provider/actor',
      credentialId: '55555555-5555-4555-8555-555555555555',
    },
  };
  const encoded = (value: unknown) =>
    ['header', Buffer.from(JSON.stringify(value)).toString('base64url'), 'signature'].join('.');
  it('routes opaque build proof to its environment coordinator and binds the common policy', async () => {
    const buildToken = encoded(buildClaims);
    const transport = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        `https://worker.example/environment-build/${environmentId}/${buildId}/aws-egress/policy`
      );
      expect(request.headers.get('x-kilo-egress-credential')).toBe(buildToken);
      return Response.json(policy);
    });
    expect(parseEgressCredential(buildToken)).toEqual(buildClaims);
    await expect(client(transport).loadPolicy(buildToken, signal())).resolves.toEqual(policy);
  });
  it.each([
    { provider: 'aws' },
    { provider: 'unknown' },
    { type: 'aws_egress' },
    { aud: 'kilo-aws-egress' },
    { build: { ...buildClaims.build, environmentId: '../other' } },
    { build: { ...buildClaims.build, credentialId: undefined } },
  ])('rejects ambiguous or malformed build routing metadata: %j', override => {
    expect(parseEgressCredential(encoded({ ...buildClaims, ...override }))).toBeNull();
  });
});
