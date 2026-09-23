import { TRPCError } from '@trpc/server';
import type { OnPremStatus } from '@cloud-agent-shared/onprem-protocol';
import {
  createOnPremEnrollment,
  getOnPremComputeStatus,
  revokeOnPremInstallation,
  selectOnPremComputeTarget,
} from './onprem-compute-client';

jest.mock(
  '@cloud-agent-shared/onprem-protocol',
  () => jest.requireActual('../../../../../services/cloud-agent-next/src/shared/onprem-protocol'),
  { virtual: true }
);
jest.mock('@/lib/config.server', () => ({ INTERNAL_API_SECRET: 'test-internal-secret' }));
jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: () => 'https://cloud-agent.example.test',
}));

const organizationId = '11111111-1111-4111-8111-111111111111';
const installationId = '22222222-2222-4222-8222-222222222222';
const privateDetail = 'private-provider-detail-test-internal-secret';
const status: OnPremStatus = {
  selected: true,
  installation: {
    id: installationId,
    organizationId,
    name: 'Local cluster',
    state: 'offline',
    enrolledAt: '2026-09-02T10:00:00.000Z',
    lastSeenAt: '2026-09-02T10:00:00.000Z',
    runnerVersion: '1.0.0',
    profile: {
      id: 'reference',
      revision: '1',
      runtimeClass: 'gvisor',
      image: 'kilo-runtime:local',
      brokerUrl: 'https://broker.example.test',
      maxLifetimeMs: 600_000,
    },
    instanceTypes: [
      {
        id: 'small',
        displayName: 'Small',
        resources: { cpuMillis: 1000, memoryMiB: 2048, diskMiB: 4096 },
      },
    ],
    diagnosticCode: 'connection_lost',
    activeAllocations: 1,
    cleanupPending: true,
  },
};

let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(privateDetail));
});

afterEach(() => {
  jest.restoreAllMocks();
});

async function expectSafeFailure(result: Promise<unknown>, code: TRPCError['code']) {
  const error: unknown = await result.catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(TRPCError);
  if (!(error instanceof TRPCError)) throw new Error('Expected a TRPCError');
  expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined();
  expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(privateDetail);
  expect(error.message).not.toContain('test-internal-secret');
}

it('uses internal authentication with a deadline, no cache, and no redirects', async () => {
  fetchMock.mockResolvedValueOnce(Response.json(status));
  const timeout = jest.spyOn(AbortSignal, 'timeout');

  await expect(getOnPremComputeStatus(organizationId)).resolves.toEqual(status);
  expect(timeout).toHaveBeenCalledWith(10_000);
  expect(fetchMock).toHaveBeenCalledWith(
    `https://cloud-agent.example.test/internal/onprem/organizations/${organizationId}`,
    expect.objectContaining({
      method: 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-internal-api-key': 'test-internal-secret',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    })
  );
});

it('normalizes organization UUIDs before URL and ownership checks', async () => {
  const canonicalId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const canonicalStatus = {
    ...status,
    installation: { ...status.installation, organizationId: canonicalId },
  };
  fetchMock.mockResolvedValueOnce(Response.json(canonicalStatus));
  await expect(getOnPremComputeStatus(canonicalId.toUpperCase())).resolves.toEqual(canonicalStatus);
  expect(fetchMock).toHaveBeenLastCalledWith(
    `https://cloud-agent.example.test/internal/onprem/organizations/${canonicalId}`,
    expect.any(Object)
  );

  const enrollment = {
    organizationId: canonicalId,
    installationId,
    bootstrapToken: 'test_bootstrap_token_not_a_secret_1234',
    expiresAt: '2026-09-02T10:10:00.000Z',
    protocolVersion: 1,
  };
  fetchMock.mockResolvedValueOnce(Response.json(enrollment));
  await expect(
    createOnPremEnrollment(canonicalId.toUpperCase(), { name: 'Local cluster' })
  ).resolves.toEqual(enrollment);
});

it.each([
  { ...status, bootstrapToken: privateDetail },
  {
    ...status,
    installation: {
      ...status.installation,
      organizationId: '33333333-3333-4333-8333-333333333333',
    },
  },
])('rejects unsafe or cross-organization status without disclosing response data', async body => {
  fetchMock.mockResolvedValueOnce(Response.json(body));
  await expectSafeFailure(getOnPremComputeStatus(organizationId), 'BAD_GATEWAY');
});

it('does not disclose transport errors or upstream error bodies', async () => {
  await expectSafeFailure(getOnPremComputeStatus(organizationId), 'SERVICE_UNAVAILABLE');
  fetchMock.mockResolvedValueOnce(Response.json({ error: privateDetail }, { status: 409 }));
  await expectSafeFailure(getOnPremComputeStatus(organizationId), 'CONFLICT');
});

it('validates the one-time enrollment response and its organization', async () => {
  const enrollment = {
    organizationId,
    installationId,
    bootstrapToken: 'test_bootstrap_token_not_a_secret_1234',
    expiresAt: '2026-09-02T10:10:00.000Z',
    protocolVersion: 1,
  };
  fetchMock.mockResolvedValueOnce(Response.json(enrollment));
  await expect(createOnPremEnrollment(organizationId, { name: 'Local cluster' })).resolves.toEqual(
    enrollment
  );
  fetchMock.mockResolvedValueOnce(
    Response.json({ ...enrollment, organizationId: '33333333-3333-4333-8333-333333333333' })
  );
  await expectSafeFailure(
    createOnPremEnrollment(organizationId, { name: 'Local cluster' }),
    'BAD_GATEWAY'
  );
});

it('forwards explicit deselection and revocation without a readiness preflight', async () => {
  const selection = { installationId, profileId: 'reference', selected: false };
  fetchMock.mockResolvedValueOnce(Response.json({ ...status, selected: false }));
  await selectOnPremComputeTarget(organizationId, selection);
  expect(fetchMock).toHaveBeenLastCalledWith(
    `https://cloud-agent.example.test/internal/onprem/organizations/${organizationId}/select`,
    expect.objectContaining({ method: 'POST', body: JSON.stringify(selection) })
  );

  const revoked = { ...status, installation: { ...status.installation, state: 'revoked' } };
  fetchMock.mockResolvedValueOnce(Response.json(revoked));
  await expect(revokeOnPremInstallation(organizationId, { installationId })).resolves.toEqual(
    revoked
  );
  expect(fetchMock).toHaveBeenLastCalledWith(
    `https://cloud-agent.example.test/internal/onprem/organizations/${organizationId}/revoke`,
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ installationId }) })
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
