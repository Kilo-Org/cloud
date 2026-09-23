import { SELF, abortAllDurableObjects, env, reset, runInDurableObject } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getOnPremInstallationStub,
  getSelectedBinding,
  reserveAllocation,
  resolveProfile,
  withOnPremInstallation,
} from '../../src/onprem/client.js';
import { onPremRoutes } from '../../src/onprem/routes.js';
import type { OnPremInstallation } from '../../src/onprem/installation.js';
import { generateSandboxCredential } from '../../src/sandbox-control/credential.js';
import {
  onPremEnrollmentResponseSchema,
  onPremExchangeResponseSchema,
  onPremStatusSchema,
  type OnPremExchangeRequest,
  type OnPremInstanceType,
  type OnPremProfile,
  type OnPremProviderBinding,
  type OnPremReport,
} from '../../src/shared/onprem-protocol.js';
import { sha256Hex } from '../../src/utils/sha256.js';

const internalKey = 'onprem-test-internal-key';
const profile: OnPremProfile = {
  id: 'local-reference',
  revision: 'v1',
  runtimeClass: 'runsc',
  image: 'onprem-fixture:local',
  brokerUrl: 'https://broker.onprem.test',
  maxLifetimeMs: 600_000,
};
const pod = { namespace: 'onprem-test', name: 'allocation-test', uid: 'pod-original' };
const instanceType: OnPremInstanceType = {
  id: 'small',
  displayName: 'Small',
  resources: { cpuMillis: 1000, memoryMiB: 2048, diskMiB: 4096 },
};
const instanceTypes: OnPremInstanceType[] = [
  instanceType,
  {
    id: 'large',
    displayName: 'Large',
    resources: { cpuMillis: 4000, memoryMiB: 8192, diskMiB: 16384 },
  },
];

function post(path: string, body: unknown, credential?: string) {
  return SELF.fetch(`http://worker.test${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credential
        ? { Authorization: `Bearer ${credential}` }
        : { 'x-internal-api-key': internalKey }),
    },
    body: JSON.stringify(body),
  });
}

async function pendingEnrollment(organizationId = crypto.randomUUID()) {
  const path = `/internal/onprem/organizations/${organizationId}`;
  const response = await post(`${path}/enrollment`, { name: 'Local installation test' });
  expect(response.status).toBe(200);
  const enrollment = onPremEnrollmentResponseSchema.parse(await response.json());
  const stub = getOnPremInstallationStub(env, organizationId);
  const credential = generateSandboxCredential();
  const input = {
    protocolVersion: 1 as const,
    credentialHash: await sha256Hex(credential),
    runnerVersion: 'fixture-v1',
    profile,
  };
  const binding: OnPremProviderBinding = {
    kind: 'onprem',
    organizationId,
    installationId: enrollment.installationId,
    profileId: profile.id,
  };
  const managementPath = `/onprem/organizations/${organizationId}/installations/${enrollment.installationId}`;
  return { ...enrollment, stub, path, managementPath, credential, input, binding };
}

type Fixture = Awaited<ReturnType<typeof pendingEnrollment>>;

function exchange(fixture: Fixture, reports: OnPremReport[] = [], ready = true) {
  return fixture.stub.exchange(fixture.installationId, fixture.credential, {
    protocolVersion: 1,
    runnerVersion: fixture.input.runnerVersion,
    ready,
    diagnosticCode: null,
    reports,
  });
}

async function readyInstallation() {
  const fixture = await pendingEnrollment();
  await fixture.stub.enroll(fixture.installationId, fixture.bootstrapToken, fixture.input);
  await exchange(fixture);
  await fixture.stub.select(fixture.organizationId, {
    installationId: fixture.installationId,
    profileId: profile.id,
    selected: true,
  });
  return fixture;
}

async function reserve(fixture: Fixture) {
  const input = {
    binding: fixture.binding,
    allocationId: crypto.randomUUID(),
    sandboxId: 'sbx__onprem_test',
    allocationName: 'onprem-test',
    createdAt: Date.now(),
    profile,
  };
  const allocation = await fixture.stub.reserveAllocation(input);
  const launch = {
    providerRef: allocation.providerRef,
    notAfter: input.createdAt + 120_000,
    bootstrap: {
      SANDBOX_CONTROL_URL: 'ws://worker.test/sandbox-control/sbx__onprem_test',
      SANDBOX_CONTROL_CREDENTIAL: generateSandboxCredential(),
    },
  };
  return { ...allocation, input, launch };
}

async function activeAllocation(fixture: Fixture) {
  const allocation = await reserve(fixture);
  await fixture.stub.launchAllocation(allocation.launch);
  const operation = (await exchange(fixture)).operations[0];
  if (!operation || operation.type !== 'launch') throw new Error('Missing launch fixture');
  const report: OnPremReport = {
    id: crypto.randomUUID(),
    allocationId: allocation.input.allocationId,
    revision: operation.revision,
    observedAt: Date.now(),
    status: 'active',
    pod,
  };
  await exchange(fixture, [report]);
  return { ...allocation, operation, report };
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected outbound request'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('OnPremInstallation HTTP and durable authority', () => {
  it('authenticates strict bounded routes and requires preflight before selection', async () => {
    const fixture = await pendingEnrollment();
    expect((await SELF.fetch(`http://worker.test${fixture.path}`)).status).toBe(401);
    expect(
      (await post(`${fixture.path}/enrollment`, { name: 'test', credential: 'forbidden' })).status
    ).toBe(400);
    const oversized = await SELF.fetch(`http://worker.test${fixture.path}/enrollment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-api-key': internalKey },
      body: JSON.stringify({ name: 'x'.repeat(65_536) }),
    });
    expect(oversized.status).toBe(413);
    const selection = {
      installationId: fixture.installationId,
      profileId: profile.id,
      selected: true,
    };
    expect((await post(`${fixture.path}/select`, selection)).status).toBe(409);
    expect(
      (await post(`${fixture.managementPath}/enroll`, fixture.input, generateSandboxCredential()))
        .status
    ).toBe(401);
    expect(
      (await post(`${fixture.managementPath}/enroll`, fixture.input, fixture.bootstrapToken)).status
    ).toBe(200);
    expect((await post(`${fixture.path}/select`, selection)).status).toBe(503);
    const heartbeat = {
      protocolVersion: 1,
      runnerVersion: fixture.input.runnerVersion,
      ready: false,
      diagnosticCode: null,
      reports: [],
    };
    expect(
      (await post(`${fixture.managementPath}/exchange`, heartbeat, fixture.bootstrapToken)).status
    ).toBe(401);
    await post(`${fixture.managementPath}/exchange`, heartbeat, fixture.credential);
    expect((await post(`${fixture.path}/select`, selection)).status).toBe(503);
    const response = await post(
      `${fixture.managementPath}/exchange`,
      { ...heartbeat, ready: true },
      fixture.credential
    );
    expect(response.status).toBe(200);
    expect(onPremExchangeResponseSchema.parse(await response.json()).operations).toEqual([]);
    const selected = await post(`${fixture.path}/select`, selection);
    expect(selected.headers.get('cache-control')).toBe('no-store');
    const status = onPremStatusSchema.parse(await selected.json());
    expect(status).toMatchObject({ selected: true, installation: { state: 'ready' } });
    expect(JSON.stringify(status)).not.toContain(fixture.credential);
    expect(JSON.stringify(status)).not.toContain(fixture.input.credentialHash);
    expect(JSON.stringify(status)).not.toContain(fixture.bootstrapToken);
    const otherOrganizationId = crypto.randomUUID();
    expect(
      (await post(`/internal/onprem/organizations/${otherOrganizationId}/select`, selection)).status
    ).toBe(404);
    await expect(async () => fixture.stub.getStatus(otherOrganizationId)).rejects.toThrow(
      'onprem_organization_mismatch'
    );
    await expect(getSelectedBinding({}, fixture.organizationId)).rejects.toThrow(
      'onprem_binding_unavailable'
    );
    const mounted = new Hono().route('/', onPremRoutes).get('/unrelated', c => c.text('ok'));
    expect((await mounted.request('http://worker.test/unrelated', {}, env)).status).toBe(200);
    await post(`${fixture.path}/revoke`, { installationId: fixture.installationId });
    expect(
      (await post(`${fixture.managementPath}/exchange`, heartbeat, fixture.credential)).status
    ).toBe(401);
  });

  it('persists catalog replacement and removal without changing allocation authority or health', async () => {
    const fixture = await readyInstallation();
    const allocation = await activeAllocation(fixture);
    const before = await fixture.stub.getAllocation(allocation.providerRef);
    const heartbeat: OnPremExchangeRequest = {
      protocolVersion: 1,
      runnerVersion: fixture.input.runnerVersion,
      ready: true,
      diagnosticCode: null,
      reports: [],
    };
    const replacement = [
      {
        ...instanceType,
        displayName: 'Updated small',
        resources: { ...instanceType.resources, memoryMiB: 4096 },
      },
    ];
    for (const advertised of [instanceTypes, replacement, [], instanceTypes, undefined]) {
      const response = await post(
        `${fixture.managementPath}/exchange`,
        { ...heartbeat, instanceTypes: advertised },
        fixture.credential
      );
      expect(response.status).toBe(200);
      expect(onPremExchangeResponseSchema.parse(await response.json()).operations).toEqual([]);
      await abortAllDurableObjects();
      fixture.stub = getOnPremInstallationStub(env, fixture.organizationId);
      const snapshot = await SELF.fetch(`http://worker.test${fixture.path}`, {
        headers: { 'x-internal-api-key': internalKey },
      });
      expect(snapshot.status).toBe(200);
      expect(onPremStatusSchema.parse(await snapshot.json())).toMatchObject({
        selected: true,
        installation: {
          state: 'ready',
          profile,
          instanceTypes: advertised ?? [],
          activeAllocations: 1,
          cleanupPending: false,
        },
      });
      expect(await fixture.stub.getSelectedBinding(fixture.organizationId)).toEqual(
        fixture.binding
      );
      expect(await fixture.stub.resolveProfile(fixture.binding)).toEqual(profile);
      expect(await fixture.stub.getAllocation(allocation.providerRef)).toEqual(before);
    }
    await fixture.stub.exchange(fixture.installationId, fixture.credential, {
      ...heartbeat,
      ready: false,
      instanceTypes,
    });
    expect(await fixture.stub.getStatus(fixture.organizationId)).toMatchObject({
      installation: { state: 'failed', instanceTypes, activeAllocations: 1, cleanupPending: false },
    });
    await fixture.stub.exchange(fixture.installationId, fixture.credential, {
      ...heartbeat,
      diagnosticCode: 'preflight_failed',
      instanceTypes: [],
    });
    expect(await fixture.stub.getStatus(fixture.organizationId)).toMatchObject({
      installation: { state: 'failed', instanceTypes: [] },
    });
  });

  it('rejects invalid catalogs and cross-installation credentials without mutating storage', async () => {
    const fixture = await readyInstallation();
    const other = await readyInstallation();
    const heartbeat: OnPremExchangeRequest = {
      protocolVersion: 1,
      runnerVersion: fixture.input.runnerVersion,
      ready: true,
      diagnosticCode: null,
      instanceTypes,
      reports: [],
    };
    await fixture.stub.exchange(fixture.installationId, fixture.credential, heartbeat);
    const before = await runInDurableObject(fixture.stub, (_instance, state) =>
      state.storage.get('onprem_installation_v1')
    );
    const otherBefore = await runInDurableObject(other.stub, (_instance, state) =>
      state.storage.get('onprem_installation_v1')
    );
    const invalidResources = [
      { ...instanceType, resources: { ...instanceType.resources, cpuMillis: 99 } },
    ];
    for (const advertised of [
      [instanceType, { ...instanceType, displayName: 'Duplicate' }],
      invalidResources,
      [{ ...instanceType, selected: true }],
      null,
    ]) {
      expect(
        (
          await post(
            `${fixture.managementPath}/exchange`,
            { ...heartbeat, ready: false, instanceTypes: advertised },
            fixture.credential
          )
        ).status
      ).toBe(400);
    }
    await expect(async () =>
      fixture.stub.exchange(fixture.installationId, fixture.credential, {
        ...heartbeat,
        ready: false,
        instanceTypes: invalidResources,
      })
    ).rejects.toThrow('onprem_invalid_request');
    const replacement = { ...heartbeat, ready: false, instanceTypes: [] };
    expect(
      (await post(`${fixture.managementPath}/exchange`, replacement, other.credential)).status
    ).toBe(401);
    expect(
      (await post(`${other.managementPath}/exchange`, replacement, fixture.credential)).status
    ).toBe(401);
    expect(
      (
        await post(
          `/onprem/organizations/${fixture.organizationId}/installations/${other.installationId}/exchange`,
          replacement,
          fixture.credential
        )
      ).status
    ).toBe(404);
    expect(
      await runInDurableObject(fixture.stub, (_instance, state) =>
        state.storage.get('onprem_installation_v1')
      )
    ).toEqual(before);
    expect(
      await runInDurableObject(other.stub, (_instance, state) =>
        state.storage.get('onprem_installation_v1')
      )
    ).toEqual(otherBefore);
  });

  it('normalizes legacy stored installations to an empty catalog', async () => {
    const fixture = await readyInstallation();
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      const stored = await state.storage.get<{ installation: Record<string, unknown> }>(
        'onprem_installation_v1'
      );
      if (!stored) throw new Error('Missing installation fixture');
      delete stored.installation.instanceTypes;
      await state.storage.put('onprem_installation_v1', stored);
    });
    await abortAllDurableObjects();
    fixture.stub = getOnPremInstallationStub(env, fixture.organizationId);
    expect(await fixture.stub.getStatus(fixture.organizationId)).toMatchObject({
      selected: true,
      installation: { state: 'ready', profile, instanceTypes: [] },
    });
    await exchange(fixture);
    expect(
      await runInDurableObject(fixture.stub, (_instance, state) =>
        state.storage.get('onprem_installation_v1')
      )
    ).toMatchObject({ installation: { instanceTypes: [] } });
  });

  it('uses one organization authority for mixed-case selection and revocation', async () => {
    const fixture = await pendingEnrollment('abcdefab-1234-4abc-8def-abcdef012345');
    const uppercaseId = fixture.organizationId.toUpperCase();
    const uppercaseStub = getOnPremInstallationStub(env, uppercaseId);
    expect(uppercaseStub.id.toString()).toBe(fixture.stub.id.toString());
    const enrollment = await uppercaseStub.createEnrollment(uppercaseId, {
      name: 'Mixed-case org',
    });
    expect(enrollment.organizationId).toBe(fixture.organizationId);
    expect(enrollment.installationId).toBe(fixture.installationId);
    const uppercasePath = `/internal/onprem/organizations/${uppercaseId}`;
    const rotatedResponse = await post(`${uppercasePath}/enrollment`, { name: 'Same authority' });
    expect(rotatedResponse.status).toBe(200);
    const rotated = onPremEnrollmentResponseSchema.parse(await rotatedResponse.json());
    expect(rotated.installationId).toBe(fixture.installationId);
    const managementPath = `/onprem/organizations/${uppercaseId}/installations/${fixture.installationId}`;
    expect(
      (await post(`${managementPath}/enroll`, fixture.input, rotated.bootstrapToken)).status
    ).toBe(200);
    const heartbeat = {
      protocolVersion: 1,
      runnerVersion: fixture.input.runnerVersion,
      ready: true,
      diagnosticCode: null,
      reports: [],
    };
    expect((await post(`${managementPath}/exchange`, heartbeat, fixture.credential)).status).toBe(
      200
    );
    const selection = {
      installationId: fixture.installationId,
      profileId: profile.id,
      selected: true,
    };
    expect((await post(`${uppercasePath}/select`, selection)).status).toBe(200);
    expect(await uppercaseStub.getSelectedBinding(uppercaseId)).toEqual(fixture.binding);
    const uppercaseBinding = { ...fixture.binding, organizationId: uppercaseId };
    expect(await resolveProfile(env, uppercaseBinding)).toEqual(profile);
    const allocationInput = {
      binding: uppercaseBinding,
      allocationId: crypto.randomUUID(),
      sandboxId: 'sbx__mixed_case_org',
      allocationName: 'mixed-case-org',
      createdAt: Date.now(),
      profile,
    };
    const allocation = await reserveAllocation(env, allocationInput);
    expect((await fixture.stub.getAllocation(allocation.providerRef))?.binding).toEqual(
      fixture.binding
    );
    await exchange(fixture, [], false);
    expect(await getSelectedBinding(env, uppercaseId)).toEqual(fixture.binding);
    await expect(resolveProfile(env, uppercaseBinding)).rejects.toThrow(
      'onprem_installation_not_ready'
    );
    expect(
      (await post(`${uppercasePath}/revoke`, { installationId: fixture.installationId })).status
    ).toBe(200);
    for (const organizationId of [fixture.organizationId, uppercaseId]) {
      const response = await SELF.fetch(
        `http://worker.test/internal/onprem/organizations/${organizationId}`,
        {
          headers: { 'x-internal-api-key': internalKey },
        }
      );
      expect(response.status).toBe(200);
      expect(onPremStatusSchema.parse(await response.json())).toMatchObject({
        selected: true,
        installation: {
          id: fixture.installationId,
          organizationId: fixture.organizationId,
          state: 'revoked',
        },
      });
      expect(await getSelectedBinding(env, organizationId)).toEqual(fixture.binding);
      expect(await fixture.stub.getStatus(organizationId)).toEqual(
        await fixture.stub.getStatus(fixture.organizationId)
      );
    }
    await expect(resolveProfile(env, uppercaseBinding)).rejects.toThrow(
      'onprem_installation_revoked'
    );
    await expect(
      reserveAllocation(env, { ...allocationInput, allocationId: crypto.randomUUID() })
    ).rejects.toThrow('onprem_installation_revoked');
    expect(
      (await post(`${uppercasePath}/enrollment`, { name: 'Cannot bypass revocation' })).status
    ).toBe(409);
    expect((await post(`${fixture.path}/select`, { ...selection, selected: false })).status).toBe(
      200
    );
    expect(await getSelectedBinding(env, uppercaseId)).toBeNull();
  });

  it('rotates pending enrollment, consumes one digest, and rejects expired enrollment', async () => {
    const fixture = await pendingEnrollment();
    const rotated = await fixture.stub.createEnrollment(fixture.organizationId, {
      name: 'Rotated',
    });
    expect(rotated.installationId).toBe(fixture.installationId);
    await expect(async () =>
      fixture.stub.enroll(fixture.installationId, fixture.bootstrapToken, fixture.input)
    ).rejects.toThrow('onprem_unauthorized');
    const replies = await Promise.all([
      fixture.stub.enroll(fixture.installationId, rotated.bootstrapToken, fixture.input),
      fixture.stub.enroll(fixture.installationId, rotated.bootstrapToken, fixture.input),
    ]);
    expect(replies[0]).toEqual(replies[1]);
    await expect(async () =>
      fixture.stub.enroll(fixture.installationId, rotated.bootstrapToken, {
        ...fixture.input,
        credentialHash: await sha256Hex(generateSandboxCredential()),
      })
    ).rejects.toThrow('onprem_unauthorized');
    await expect(async () =>
      fixture.stub.createEnrollment(fixture.organizationId, { name: 'Replacement' })
    ).rejects.toThrow('onprem_already_enrolled');
    const expired = await pendingEnrollment();
    await runInDurableObject<OnPremInstallation, void>(
      getOnPremInstallationStub(env, expired.organizationId),
      async instance => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expired.expiresAt) + 1);
        try {
          await expect(
            instance.enroll(expired.installationId, expired.bootstrapToken, expired.input)
          ).rejects.toThrow('onprem_enrollment_expired');
        } finally {
          clock.mockRestore();
        }
      }
    );
  });

  it('persists reservation and launch retries, pins the first UID, and keeps terminal tombstones', async () => {
    const fixture = await readyInstallation();
    const allocation = await reserve(fixture);
    expect(await fixture.stub.reserveAllocation(allocation.input)).toEqual({
      providerRef: allocation.providerRef,
      hardStopAt: allocation.hardStopAt,
    });
    expect((await exchange(fixture)).operations).toEqual([]);
    await fixture.stub.launchAllocation(allocation.launch);
    const first = (await exchange(fixture)).operations[0];
    if (!first || first.type !== 'launch') throw new Error('Missing launch fixture');
    await fixture.stub.launchAllocation(allocation.launch);
    await expect(async () =>
      fixture.stub.launchAllocation({
        ...allocation.launch,
        notAfter: allocation.launch.notAfter + 1,
      })
    ).rejects.toThrow('onprem_allocation_conflict');
    await abortAllDurableObjects();
    fixture.stub = getOnPremInstallationStub(env, fixture.organizationId);
    expect((await exchange(fixture)).operations).toEqual([first]);
    const report: OnPremReport = {
      id: crypto.randomUUID(),
      allocationId: first.allocationId,
      revision: first.revision,
      observedAt: Date.now(),
      status: 'active',
      pod,
    };
    expect((await exchange(fixture, [report])).acknowledgedReportIds).toEqual([report.id]);
    expect(await fixture.stub.getAllocation(allocation.providerRef)).toMatchObject({
      status: 'active',
      acknowledgementFresh: true,
      pod,
    });
    await runInDurableObject<OnPremInstallation, void>(fixture.stub, async (_instance, state) => {
      const stored = JSON.stringify(await state.storage.get('onprem_installation_v1'));
      expect(stored).not.toContain(allocation.launch.bootstrap.SANDBOX_CONTROL_CREDENTIAL);
    });
    const authorization = {
      installationId: fixture.installationId,
      credential: fixture.credential,
      providerRef: allocation.providerRef,
      podUid: pod.uid,
    };
    expect(await fixture.stub.authorizeAllocation(authorization)).toMatchObject({
      allocationId: first.allocationId,
      binding: fixture.binding,
    });
    await expect(async () =>
      fixture.stub.authorizeAllocation({ ...authorization, podUid: 'pod-impostor' })
    ).rejects.toThrow('onprem_unauthorized');
    const mismatch = await exchange(fixture, [
      {
        ...report,
        id: crypto.randomUUID(),
        observedAt: Math.max(Date.now(), report.observedAt + 1),
        status: 'terminal',
        pod: { ...pod, uid: 'pod-impostor' },
      },
    ]);
    const stop = mismatch.operations[0];
    expect(stop).toMatchObject({ type: 'stop', reason: 'pod_identity_mismatch' });
    if (!stop) throw new Error('Missing stop fixture');
    expect(await fixture.stub.stopAllocation(allocation.providerRef)).toBe('retryable');
    expect((await exchange(fixture)).operations).toEqual([stop]);
    expect(await fixture.stub.getAllocation(allocation.providerRef)).toMatchObject({
      status: 'unknown',
      pod,
    });
    await expect(async () =>
      fixture.stub.reserveAllocation({ ...allocation.input, allocationId: crypto.randomUUID() })
    ).rejects.toThrow('onprem_allocation_conflict');
    await expect(async () => fixture.stub.launchAllocation(allocation.launch)).rejects.toThrow(
      'onprem_allocation_stopped'
    );
    await exchange(fixture, [
      {
        ...report,
        id: crypto.randomUUID(),
        revision: stop.revision,
        observedAt: Math.max(Date.now(), report.observedAt + 2),
        status: 'unknown',
      },
    ]);
    expect((await fixture.stub.observeAllocation(allocation.providerRef)).status).toBe('unknown');
    await exchange(fixture, [
      {
        ...report,
        id: crypto.randomUUID(),
        revision: stop.revision,
        observedAt: Math.max(Date.now(), report.observedAt + 3),
        status: 'terminal',
        pod: undefined,
      },
    ]);
    expect((await fixture.stub.observeAllocation(allocation.providerRef)).status).toBe('unknown');
    await exchange(fixture, [
      {
        ...report,
        id: crypto.randomUUID(),
        revision: stop.revision,
        observedAt: Math.max(Date.now(), report.observedAt + 4),
        status: 'terminal',
      },
    ]);
    await exchange(fixture, [{ ...report, id: crypto.randomUUID(), observedAt: Date.now() + 4 }]);
    expect(await fixture.stub.stopAllocation(allocation.providerRef)).toBe('terminal');
    expect((await exchange(fixture)).operations).toEqual([]);
    expect((await reserve(fixture)).providerRef).not.toBe(allocation.providerRef);
  });

  it('does not refresh allocation evidence from repeated report IDs or a live management heartbeat', async () => {
    const fixture = await readyInstallation();
    const allocation = await activeAllocation(fixture);
    await runInDurableObject<OnPremInstallation, void>(fixture.stub, async instance => {
      const now = Date.now() + 61_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        expect((await instance.getStatus(fixture.organizationId)).installation?.state).toBe(
          'offline'
        );
        expect(await instance.getSelectedBinding(fixture.organizationId)).toEqual(fixture.binding);
        const response = await instance.exchange(fixture.installationId, fixture.credential, {
          protocolVersion: 1,
          runnerVersion: 'fixture-v1',
          ready: true,
          diagnosticCode: null,
          reports: [{ ...allocation.report, observedAt: now }],
        });
        expect(response.acknowledgedReportIds).toEqual([allocation.report.id]);
        expect(await instance.getAllocation(allocation.providerRef)).toMatchObject({
          status: 'unknown',
          acknowledgedAt: allocation.report.observedAt,
          acknowledgementFresh: false,
        });
        await expect(
          instance.authorizeAllocation({
            installationId: fixture.installationId,
            credential: fixture.credential,
            providerRef: allocation.providerRef,
            podUid: pod.uid,
          })
        ).rejects.toThrow('onprem_unauthorized');
        clock.mockReturnValue(now + 61_000);
        await instance.exchange(fixture.installationId, fixture.credential, {
          protocolVersion: 1,
          runnerVersion: 'fixture-v1',
          ready: true,
          diagnosticCode: null,
          reports: [{ ...allocation.report, observedAt: now + 61_000 }],
        });
        expect((await instance.getAllocation(allocation.providerRef))?.status).toBe('unknown');
      } finally {
        clock.mockRestore();
      }
    });
  });

  it('accepts delayed termination evidence without refreshing stale liveness or changing the pinned Pod', async () => {
    const fixture = await readyInstallation();
    const allocation = await activeAllocation(fixture);
    await runInDurableObject<OnPremInstallation, void>(fixture.stub, async instance => {
      const now = allocation.report.observedAt + 61_000;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      const heartbeat = {
        protocolVersion: 1 as const,
        runnerVersion: 'fixture-v1',
        ready: true,
        diagnosticCode: null,
        reports: [],
      };
      try {
        await instance.exchange(fixture.installationId, fixture.credential, {
          ...heartbeat,
          reports: [{ ...allocation.report, id: crypto.randomUUID() }],
        });
        expect(await instance.getAllocation(allocation.providerRef)).toMatchObject({
          status: 'unknown',
          acknowledgedAt: allocation.report.observedAt,
          acknowledgementFresh: false,
        });
        await instance.stopAllocation(allocation.providerRef);
        const stop = (
          await instance.exchange(fixture.installationId, fixture.credential, heartbeat)
        ).operations[0];
        if (!stop || stop.type !== 'stop') throw new Error('Missing stop fixture');
        await instance.exchange(fixture.installationId, fixture.credential, {
          ...heartbeat,
          reports: [
            {
              ...allocation.report,
              id: crypto.randomUUID(),
              revision: stop.revision,
              observedAt: now,
              status: 'unknown',
            },
          ],
        });
        const terminal: OnPremReport = {
          ...allocation.report,
          id: crypto.randomUUID(),
          revision: stop.revision,
          observedAt: allocation.report.observedAt + 500,
          status: 'terminal',
        };
        for (const invalid of [
          { ...terminal, id: crypto.randomUUID(), pod: { ...pod, uid: 'pod-impostor' } },
          { ...terminal, id: crypto.randomUUID(), pod: undefined },
          { ...terminal, id: crypto.randomUUID(), revision: allocation.operation.revision },
          { ...terminal, id: crypto.randomUUID(), observedAt: allocation.input.createdAt - 31_000 },
          { ...terminal, id: crypto.randomUUID(), observedAt: now + 31_000 },
        ]) {
          const ignored = await instance.exchange(fixture.installationId, fixture.credential, {
            ...heartbeat,
            reports: [invalid],
          });
          expect(ignored.acknowledgedReportIds).toEqual([]);
          expect((await instance.observeAllocation(allocation.providerRef)).status).toBe('unknown');
        }
        const response = await instance.exchange(fixture.installationId, fixture.credential, {
          ...heartbeat,
          reports: [terminal],
        });
        expect(response.acknowledgedReportIds).toEqual([terminal.id]);
        expect(response.operations).toEqual([]);
        expect(await instance.getAllocation(allocation.providerRef)).toMatchObject({
          status: 'terminal',
          acknowledgementFresh: false,
          pod,
        });
        expect(await instance.getStatus(fixture.organizationId)).toMatchObject({
          installation: { activeAllocations: 0, cleanupPending: false },
        });
        const delayed = {
          ...terminal,
          id: crypto.randomUUID(),
          revision: allocation.operation.revision,
        };
        const conflicting = {
          ...terminal,
          id: crypto.randomUUID(),
          pod: { ...pod, uid: 'pod-conflict' },
        };
        const replay = await instance.exchange(fixture.installationId, fixture.credential, {
          ...heartbeat,
          reports: [terminal, delayed, conflicting],
        });
        expect(replay.acknowledgedReportIds).toEqual([terminal.id, delayed.id]);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it('rechecks revocation after crypto and retains selection and unresolved cleanup', async () => {
    const fixture = await readyInstallation();
    const allocation = await activeAllocation(fixture);
    await fixture.stub.exchange(fixture.installationId, fixture.credential, {
      protocolVersion: 1,
      runnerVersion: fixture.input.runnerVersion,
      ready: true,
      diagnosticCode: null,
      instanceTypes,
      reports: [],
    });
    await runInDurableObject<OnPremInstallation, void>(fixture.stub, async instance => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
      const digest = vi
        .spyOn(crypto.subtle, 'digest')
        .mockImplementation(async (algorithm, data) => {
          const result = await originalDigest(algorithm, data);
          entered.resolve();
          await release.promise;
          return result;
        });
      try {
        const pending = instance.authorizeAllocation({
          installationId: fixture.installationId,
          credential: fixture.credential,
          providerRef: allocation.providerRef,
          podUid: pod.uid,
        });
        const rejected = expect(pending).rejects.toThrow('onprem_unauthorized');
        await entered.promise;
        await instance.revoke(fixture.organizationId, { installationId: fixture.installationId });
        release.resolve();
        await rejected;
      } finally {
        release.resolve();
        digest.mockRestore();
      }
    });
    expect(await fixture.stub.getSelectedBinding(fixture.organizationId)).toEqual(fixture.binding);
    expect(await fixture.stub.getStatus(fixture.organizationId)).toMatchObject({
      selected: true,
      installation: { state: 'revoked', instanceTypes, cleanupPending: true, activeAllocations: 1 },
    });
    await expect(async () => fixture.stub.reserveAllocation(allocation.input)).rejects.toThrow(
      'onprem_installation_revoked'
    );
    await expect(async () => fixture.stub.launchAllocation(allocation.launch)).rejects.toThrow(
      'onprem_installation_revoked'
    );
    await expect(async () =>
      fixture.stub.createEnrollment(fixture.organizationId, { name: 'Replacement' })
    ).rejects.toThrow('onprem_cleanup_pending');
    const response = await exchange(fixture, [
      {
        ...allocation.report,
        id: crypto.randomUUID(),
        observedAt: Date.now() + 1,
      },
    ]);
    expect(response.revoked).toBe(true);
    expect(
      (await fixture.stub.getStatus(fixture.organizationId)).installation?.instanceTypes
    ).toEqual(instanceTypes);
    expect(response.operations.every(operation => operation.type === 'stop')).toBe(true);
    const stop = response.operations[0];
    if (!stop) throw new Error('Missing revoked stop fixture');
    await exchange(fixture, [
      {
        ...allocation.report,
        id: crypto.randomUUID(),
        revision: stop.revision,
        observedAt: Math.max(Date.now(), allocation.report.observedAt + 2),
        status: 'terminal',
      },
    ]);
    expect(
      (await fixture.stub.getStatus(fixture.organizationId)).installation?.cleanupPending
    ).toBe(false);
    await fixture.stub.select(fixture.organizationId, {
      installationId: fixture.installationId,
      profileId: profile.id,
      selected: false,
    });
    const replacement = await fixture.stub.createEnrollment(fixture.organizationId, {
      name: 'Replacement',
    });
    expect(replacement.installationId).not.toBe(fixture.installationId);
    expect(await fixture.stub.getStatus(fixture.organizationId)).toMatchObject({
      installation: { id: replacement.installationId, state: 'pending', instanceTypes: [] },
    });
    expect((await fixture.stub.getAllocation(allocation.providerRef))?.status).toBe('terminal');
  });

  it('expires launch authority, purges bootstrap, and treats missing allocations as unknown', async () => {
    const fixture = await readyInstallation();
    const allocation = await reserve(fixture);
    await expect(async () =>
      fixture.stub.reserveAllocation({
        ...allocation.input,
        allocationId: crypto.randomUUID(),
        createdAt: Date.now() - 300_001,
      })
    ).rejects.toThrow('onprem_allocation_expired');
    await fixture.stub.launchAllocation(allocation.launch);
    await runInDurableObject<OnPremInstallation, void>(fixture.stub, async (instance, state) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(allocation.launch.notAfter + 1);
      try {
        await instance.alarm();
        expect((await instance.getAllocation(allocation.providerRef))?.phase).toBe('stopping');
        expect(JSON.stringify(await state.storage.get('onprem_installation_v1'))).not.toContain(
          allocation.launch.bootstrap.SANDBOX_CONTROL_CREDENTIAL
        );
        clock.mockReturnValue(allocation.hardStopAt + 86_400_001);
        expect(await instance.getAllocation(allocation.providerRef)).toMatchObject({
          status: 'unknown',
          phase: 'stopping',
        });
      } finally {
        clock.mockRestore();
      }
    });
    const missing = `onprem:v1:${fixture.installationId}:${crypto.randomUUID()}`;
    expect((await fixture.stub.observeAllocation(missing)).status).toBe('unknown');
    expect(await fixture.stub.stopAllocation(missing)).toBe('retryable');
    await expect(
      withOnPremInstallation(
        env,
        fixture.organizationId,
        async () => {
          throw new Error('Authorization: Bearer transport-fixture-secret');
        },
        'onPremTransportFixture'
      )
    ).rejects.toThrow('onprem_unavailable');
  });
});
