import { afterEach, describe, expect, it, vi } from 'vitest';
import { awsEgressPolicySchema } from '@kilocode/worker-utils/aws-egress';
import { awsEgressFixture } from '../../test/fixtures/aws-egress.js';
import { awsOperationSchema } from '../sandbox-control/aws-operation.js';
import { buildNativeEgressAllowlist } from '../sandbox-control/egress-policy.js';
import * as admission from './aws-admission.js';
import { createAwsSandboxEgress } from './aws-sandbox-context.js';

afterEach(() => vi.restoreAllMocks());

async function sandboxEgress(allowlist?: readonly string[]) {
  const f = await awsEgressFixture();
  awsOperationSchema.parse(f.context.operation);
  const createAdmission = admission.createAwsEgressAdmission;
  // Keep context assembly and admission real. Replace only remote authority and clock dependencies.
  vi.spyOn(admission, 'createAwsEgressAdmission').mockImplementation(deps =>
    createAdmission({
      ...deps,
      resolveConfiguration: f.resolveConfiguration,
      readMetadata: f.readMetadata,
      signingSecret: async () => 'worker-signing-test',
      now: () => f.now,
    })
  );
  const api = createAwsSandboxEgress({
    env: { ...f.env, WORKER_URL: 'https://agent.example.com' },
    admission: { serial: async operation => operation(), resolve: f.resolve, persist: f.persist },
    readContext: async () => structuredClone(f.context),
    operationStorage: {
      get: vi.fn().mockImplementation(async () => structuredClone(f.context.operation)),
      transaction: vi.fn().mockRejectedValue(new Error('Unexpected egress operation update')),
      list: vi.fn().mockResolvedValue(new Map()),
      delete: vi.fn().mockRejectedValue(new Error('Unexpected egress operation deletion')),
    },
    readCredentialHash: async () => f.context.credentialHash,
    readPolicy: () => ({ allowlist, audit: true }),
  });
  return { f, api };
}

describe('AWS sandbox policy assembly', () => {
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
