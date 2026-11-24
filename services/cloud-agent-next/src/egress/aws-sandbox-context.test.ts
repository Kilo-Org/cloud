import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AWS_EGRESS_POLICY_REFRESH_MS,
  awsEgressPolicySchema,
} from '@kilocode/worker-utils/aws-egress';
import { awsEgressFixture } from '../../test/fixtures/aws-egress.js';
import { logicalId } from '../scm-broker/test-fixtures.js';
import { awsEcsOperationSchema } from '../sandbox-control/aws-ecs-operation.js';
import { buildNativeEgressAllowlist } from '../sandbox-control/egress-policy.js';
import { createAwsSandboxEgress } from './aws-sandbox-context.js';
const generation = '22222222-2222-4222-8222-222222222222';
const allocationId = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const fixture = (options: { now?: () => number } = {}) => awsEgressFixture(options);
describe('ECS deployment and allocation admission', () => {
  it('keeps engine identity exact and requires the stored compute deadline', async () => {
    const f = await fixture();
    expect((await f.api.policy(f.proof)).status).toBe(200);
    f.context.provider = 'vercel';
    expect((await f.api.policy(f.proof)).status).toBe(403);
    f.context.provider = 'aws-ecs';
    delete f.context.operation!.deadlineAt;
    expect((await f.api.policy(f.proof)).status).toBe(403);
  });
  it('bounds policy validity by the refresh interval, certificate and compute deadline', async () => {
    const f = await fixture();
    f.setNow(f.now + 9 * 3_600_000);
    const response = await f.api.policy(f.proof);
    expect(response.status).toBe(200);
    const value = awsEgressPolicySchema.parse(await response.json());
    expect(value.validUntil).toBe(f.now + 9 * 3_600_000 + 30_000);
    expect(f.resolveConfiguration).toHaveBeenCalledWith(f.context.byoc);
  });
  it('expires egress at the stored compute deadline', async () => {
    let clock = Date.now();
    const f = await fixture({ now: () => clock });
    f.context.operation!.deadlineAt = clock + 1000;
    const policy = awsEgressPolicySchema.parse(await (await f.api.policy(f.proof)).json());
    expect(policy.validUntil).toBe(clock + 1000);
    clock += 1000;
    expect((await f.api.policy(f.proof)).status).toBe(403);
  });
  it('admits an issued launch before wrapper welcome and projects current managed hosts', async () => {
    const f = await fixture();
    f.context.allowlist = ['github.com'];
    const response = await f.api.policy(f.proof);
    expect(response.status).toBe(200);
    const policy = awsEgressPolicySchema.parse(await response.json());
    expect(policy).toMatchObject({
      generation,
      sandboxId: logicalId,
      allocationId,
      allocationRef: f.context.allocation.providerRef,
      audit: true,
    });
    expect(policy.interceptedHosts).toContain('github.com');
    expect(policy.allowlist).toContain('github.com');
    expect(JSON.stringify(policy)).not.toContain('kgh2.');
    expect(JSON.stringify(policy)).not.toContain('upstream-secret');
    f.context.grants = [];
    expect(
      awsEgressPolicySchema.parse(await (await f.api.policy(f.proof)).json()).interceptedHosts
    ).toEqual([]);
  });
  it.each(['credential', 'allocation', 'generation', 'stopped', 'unissued'])(
    'rejects %s before backend or AWS reads',
    async change => {
      const f = await fixture();
      if (change === 'credential') f.context.credentialHash = 'f'.repeat(64);
      if (change === 'allocation')
        f.context.allocation.allocationId = '33333333-3333-4333-8333-333333333333';
      if (change === 'generation')
        f.context.operation!.config.proxy!.generation = '33333333-3333-4333-8333-333333333333';
      if (change === 'stopped') f.context.allocation.kind = 'stopping';
      if (change === 'unissued') f.context.operation!.phase = 'created';
      expect((await f.api.policy(f.proof)).status).toBeGreaterThanOrEqual(400);
      expect(f.resolveConfiguration).not.toHaveBeenCalled();
      expect(f.readMetadata).not.toHaveBeenCalled();
    }
  );
  it('reuses deployment metadata across policy, audit and SCM while reauthorizing each request', async () => {
    const f = await fixture();
    expect((await f.api.policy(f.proof)).status).toBe(200);
    expect(
      (
        await f.api.audit(f.proof, {
          requestId: crypto.randomUUID(),
          allocationRef: f.context.allocation.providerRef,
          timestamp: new Date(f.now).toISOString(),
          scope: 'connection',
          method: 'CONNECT',
          hostname: 'github.com',
          protocol: 'https:',
          port: 443,
          decision: 'allowed',
        })
      ).status
    ).toBe(204);
    expect(
      await f.api.admitScm(f.proof, {
        target: {
          url: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
          method: 'GET',
        },
        authorization: { authorization: `Bearer ${f.scope.scm!.alias}` },
      })
    ).toMatchObject({ ok: true });
    expect(f.resolveConfiguration).toHaveBeenCalledTimes(3);
    expect(f.readMetadata).toHaveBeenCalledOnce();
  });

  it('expires deployment metadata, fails closed on refresh failure and retries the next request', async () => {
    let clock = Date.now();
    const f = await fixture({ now: () => clock });
    expect((await f.api.policy(f.proof)).status).toBe(200);
    clock += AWS_EGRESS_POLICY_REFRESH_MS - 1;
    expect((await f.api.policy(f.proof)).status).toBe(200);
    expect(f.readMetadata).toHaveBeenCalledOnce();
    clock++;
    f.readMetadata.mockRejectedValueOnce(new Error('Synthetic metadata outage'));
    expect((await f.api.policy(f.proof)).status).toBe(503);
    expect(f.readMetadata).toHaveBeenCalledTimes(2);
    expect((await f.api.policy(f.proof)).status).toBe(200);
    expect(f.readMetadata).toHaveBeenCalledTimes(3);
  });

  it('coalesces concurrent metadata reads and rechecks the allocation after they settle', async () => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const read = f.readMetadata.getMockImplementation()!;
    f.readMetadata.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return read();
    });
    const first = f.api.policy(f.proof);
    await started.promise;
    const second = f.api.policy(f.proof);
    // Wait for the second caller's fresh connection authorization before changing local state.
    await vi.waitFor(() => expect(f.resolveConfiguration).toHaveBeenCalledTimes(2));
    f.context.allocation.kind = 'stopping';
    release.resolve();
    expect((await first).status).toBe(403);
    expect((await second).status).toBe(403);
    expect(f.readMetadata).toHaveBeenCalledOnce();
  });

  it('does not extend a cached deployment beyond its certificate expiry', async () => {
    let clock = Date.now();
    const f = await fixture({ now: () => clock });
    f.metadata.deployment.expiresAt = new Date(clock + 1000).toISOString();
    const policy = awsEgressPolicySchema.parse(await (await f.api.policy(f.proof)).json());
    expect(policy.validUntil).toBe(clock + 1000);
    clock += 1001;
    expect((await f.api.policy(f.proof)).status).toBe(403);
    expect(f.readMetadata).toHaveBeenCalledTimes(2);
  });

  it.each(['source', 'configuration'])(
    'does not reuse deployment metadata after a %s change',
    async change => {
      const f = await fixture();
      expect((await f.api.policy(f.proof)).status).toBe(200);
      if (change === 'source')
        f.context.byoc!.credentialId = '33333333-3333-4333-8333-333333333333';
      else f.config.bucket = 'replacement-artifacts';
      expect((await f.api.policy(f.proof)).status).toBe(200);
      expect(f.readMetadata).toHaveBeenCalledTimes(2);
      expect(f.resolveConfiguration).toHaveBeenCalledTimes(2);
    }
  );

  it('does not let an older failed read remove a replacement deployment cache entry', async () => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.readMetadata.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      throw new Error('Synthetic old deployment failure');
    });
    const old = f.api.policy(f.proof);
    await started.promise;
    f.config.bucket = 'replacement-artifacts';
    expect((await f.api.policy(f.proof)).status).toBe(200);
    release.resolve();
    expect((await old).status).toBe(503);
    expect((await f.api.policy(f.proof)).status).toBe(200);
    expect(f.readMetadata).toHaveBeenCalledTimes(2);
  });

  it('requires deployment identity and rechecks exact current connection on every request', async () => {
    const f = await fixture();
    expect((await f.api.policy({ ...f.proof, identity: 'f'.repeat(64) })).status).toBe(401);
    expect((await f.api.policy(f.proof)).status).toBe(200);
    f.resolveConfiguration.mockRejectedValueOnce(new Error('connection revoked'));
    expect((await f.api.policy(f.proof)).status).toBe(503);
    f.resolveConfiguration.mockResolvedValueOnce({ ...f.config, capacityProvider: 'replacement' });
    expect((await f.api.policy(f.proof)).status).toBe(403);
  });
  it.each(['allocation', 'credential', 'connection', 'stop'])(
    'rechecks %s after remote identity reads',
    async change => {
      const f = await fixture();
      const read = f.readMetadata.getMockImplementation()!;
      f.readMetadata.mockImplementationOnce(async () => {
        const result = await read();
        if (change === 'allocation') f.context.allocation.providerRef = 'replacement';
        if (change === 'credential') f.context.credentialHash = 'd'.repeat(64);
        if (change === 'connection')
          f.context.byoc!.credentialId = '33333333-3333-4333-8333-333333333333';
        if (change === 'stop') f.context.operation!.phase = 'stopping';
        return result;
      });
      expect((await f.api.policy(f.proof)).status).toBe(403);
    }
  );
  it('stores only an authenticated allocation audit and acknowledges the persisted effect', async () => {
    const f = await fixture();
    const row = {
      requestId: '33333333-3333-4333-8333-333333333333',
      allocationRef: f.context.allocation.providerRef!,
      timestamp: new Date(f.now).toISOString(),
      method: 'CONNECT',
      scope: 'connection',
      hostname: 'denied.example',
      protocol: 'https:',
      port: 443,
      decision: 'denied',
    };
    expect((await f.api.audit(f.proof, row)).status).toBe(204);
    expect(f.recordEgressRequest).toHaveBeenCalledExactlyOnceWith(row);
    expect((await f.api.audit(f.proof, { ...row, allocationRef: 'foreign' })).status).toBe(403);
    expect(f.recordEgressRequest).toHaveBeenCalledTimes(1);
  });
  it('returns authority without redeeming credentials or forwarding', async () => {
    const f = await fixture();
    const forwarded = vi.fn();
    vi.stubGlobal('fetch', forwarded);
    const input = {
      target: {
        url: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
        method: 'GET',
      },
      authorization: { authorization: `Bearer ${f.scope.scm!.alias}` },
    };
    const admission = await f.api.admitScm(f.proof, input);
    expect(admission).toMatchObject({
      ok: true,
      authority: { type: 'managed', provider: 'github' },
    });
    expect(f.redeem).not.toHaveBeenCalled();
    expect(forwarded).not.toHaveBeenCalled();
    f.context.grants = [];
    expect(await f.api.admitScm(f.proof, input)).toMatchObject({ ok: false, status: 403 });
  });
});

async function sandboxEgress(allowlist?: readonly string[]) {
  const f = await awsEgressFixture();
  awsEcsOperationSchema.parse(f.context.operation);
  // Keep context assembly and admission real. Replace only remote authority and clock dependencies.
  const api = createAwsSandboxEgress({
    env: { ...f.env, WORKER_URL: 'https://agent.example.com' },
    admission: { serial: async operation => operation(), resolve: f.resolve, persist: f.persist },
    readContext: async () => structuredClone(f.context),
    operationStorage: {
      get: vi.fn().mockImplementation(async (key: string) => {
        expect(key).toBe(`aws-ecs-operation:${f.context.operation?.ref.intentId}`);
        return structuredClone(f.context.operation);
      }),
      transaction: vi.fn().mockRejectedValue(new Error('Unexpected egress operation update')),
      list: vi.fn().mockResolvedValue(new Map()),
      delete: vi.fn().mockRejectedValue(new Error('Unexpected egress operation deletion')),
    },
    readCredentialHash: async () => f.context.credentialHash,
    readPolicy: () => ({ allowlist, audit: true }),
    resolveConfiguration: f.resolveConfiguration,
    readMetadata: f.readMetadata,
    signingSecret: async () => 'worker-signing-test',
    now: () => f.now,
  });
  return { f, api };
}

describe('ECS sandbox policy assembly', () => {
  it('adds the pinned bucket through the shared builder without changing the stored pin', async () => {
    const pin = Object.freeze(
      buildNativeEgressAllowlist({
        allowlist: ['packages.example.com'],
        env: { WORKER_URL: 'https://agent.example.com' },
      })
    );
    const before = [...pin];
    const { f, api } = await sandboxEgress(pin);
    const host = `${f.config.bucket}.s3.${f.config.region}.amazonaws.com`;
    for (let refresh = 0; refresh < 2; refresh++) {
      const response = await api.policy(f.proof);
      expect(response.status).toBe(200);
      const policy = awsEgressPolicySchema.parse(await response.json());
      expect(policy.allowlist).toEqual([...before, host].sort());
      expect(policy.allowlist?.filter(value => value === host)).toHaveLength(1);
      expect(pin).toEqual(before);
    }
    f.resolveConfiguration.mockResolvedValueOnce({ ...f.config, bucket: 'replacement-bucket' });
    expect((await api.policy(f.proof)).status).toBe(403);
    expect(pin).toEqual(before);
  });

  it('keeps unrestricted allocations unrestricted', async () => {
    const { f, api } = await sandboxEgress();
    const response = await api.policy(f.proof);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('allowlist');
  });
});
