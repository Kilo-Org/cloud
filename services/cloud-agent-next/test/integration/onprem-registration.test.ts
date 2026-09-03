import { abortAllDurableObjects, env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getOnPremInstallationStub } from '../../src/onprem/client.js';
import type { OnPremInstallation } from '../../src/onprem/installation.js';
import { generateSandboxCredential } from '../../src/sandbox-control/credential.js';
import {
  ON_PREM_CLOCK_SKEW_MS,
  type OnPremExchangeRequest,
  type OnPremProfile,
  type OnPremProviderBinding,
  type OnPremReport,
} from '../../src/shared/onprem-protocol.js';
import { sha256Hex } from '../../src/utils/sha256.js';

const profile: OnPremProfile = {
  id: 'registration-test',
  revision: 'v1',
  runtimeClass: 'runsc',
  image: 'onprem-fixture:local',
  brokerUrl: 'https://broker.onprem.test',
  maxLifetimeMs: 600_000,
};
const pod = { namespace: 'onprem-test', name: 'allocation-test', uid: 'pod-original' };

function heartbeat(reports: OnPremReport[] = []): OnPremExchangeRequest {
  return {
    protocolVersion: 1,
    runnerVersion: 'fixture-v1',
    ready: true,
    diagnosticCode: null,
    reports,
  };
}

async function launchedAllocation() {
  const organizationId = crypto.randomUUID();
  const stub = getOnPremInstallationStub(env, organizationId);
  const enrollment = await stub.createEnrollment(organizationId, { name: 'Registration test' });
  const installationId = enrollment.installationId;
  const credential = generateSandboxCredential();
  await stub.enroll(installationId, enrollment.bootstrapToken, {
    protocolVersion: 1,
    credentialHash: await sha256Hex(credential),
    runnerVersion: 'fixture-v1',
    profile,
  });
  await stub.exchange(installationId, credential, heartbeat());
  const binding: OnPremProviderBinding = {
    kind: 'onprem',
    organizationId,
    installationId,
    profileId: profile.id,
  };
  const allocationId = crypto.randomUUID();
  const createdAt = Date.now();
  const allocation = await stub.reserveAllocation({
    binding,
    allocationId,
    createdAt,
    profile,
    sandboxId: 'sbx__registration_test',
    allocationName: 'registration-test',
  });
  await stub.launchAllocation({
    providerRef: allocation.providerRef,
    notAfter: createdAt + 120_000,
    bootstrap: {
      SANDBOX_CONTROL_URL: 'ws://worker.test/sandbox-control/sbx__registration_test',
      SANDBOX_CONTROL_CREDENTIAL: generateSandboxCredential(),
    },
  });
  const operation = (await stub.exchange(installationId, credential, heartbeat())).operations[0];
  if (!operation || operation.type !== 'launch') throw new Error('Missing launch fixture');
  const report: OnPremReport = {
    id: crypto.randomUUID(),
    allocationId,
    revision: operation.revision,
    observedAt: Date.now(),
    status: 'pending',
    pod,
  };
  return { stub, organizationId, installationId, credential, allocation, report };
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected outbound request'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('On-prem Pod registration acknowledgements', () => {
  it.each([false, true])(
    'does not acknowledge future registration and can retry it (legacy receipt: %s)',
    async legacyReceipt => {
      const fixture = await launchedAllocation();
      await runInDurableObject<OnPremInstallation, void>(fixture.stub, async (instance, state) => {
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const report = { ...fixture.report, observedAt: now + ON_PREM_CLOCK_SKEW_MS * 2 };
        if (legacyReceipt) {
          const stored = await state.storage.get<{
            reports: Array<{ id: string; receivedAt: number }>;
          }>('onprem_installation_v1');
          if (!stored) throw new Error('Missing installation fixture');
          stored.reports.push({ id: report.id, receivedAt: now });
          await state.storage.put('onprem_installation_v1', stored);
        }
        try {
          const rejected = await instance.exchange(
            fixture.installationId,
            fixture.credential,
            heartbeat([report])
          );
          expect(rejected.acknowledgedReportIds).toEqual([]);
          expect(await instance.getAllocation(fixture.allocation.providerRef)).toMatchObject({
            pod: null,
            acknowledgementFresh: false,
          });
          clock.mockReturnValue(report.observedAt);
          const registered = await instance.exchange(
            fixture.installationId,
            fixture.credential,
            heartbeat([report])
          );
          expect(registered.acknowledgedReportIds).toEqual([report.id]);
          expect(await instance.getAllocation(fixture.allocation.providerRef)).toMatchObject({
            pod,
            acknowledgementFresh: false,
          });
          clock.mockReturnValue(report.observedAt + 1);
          await instance.exchange(
            fixture.installationId,
            fixture.credential,
            heartbeat([
              {
                ...report,
                id: crypto.randomUUID(),
                status: 'active',
                observedAt: report.observedAt + 1,
              },
            ])
          );
          expect(
            await instance.authorizeAllocation({
              installationId: fixture.installationId,
              credential: fixture.credential,
              providerRef: fixture.allocation.providerRef,
              podUid: pod.uid,
            })
          ).toMatchObject({ allocationId: report.allocationId });
        } finally {
          clock.mockRestore();
        }
      });
    }
  );

  it.each([-1, 1])(
    'accepts registration at the shared clock-skew boundary (%s)',
    async direction => {
      const fixture = await launchedAllocation();
      await runInDurableObject<OnPremInstallation, void>(fixture.stub, async instance => {
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const report = { ...fixture.report, observedAt: now + direction * ON_PREM_CLOCK_SKEW_MS };
        try {
          const result = await instance.exchange(
            fixture.installationId,
            fixture.credential,
            heartbeat([report])
          );
          expect(result.acknowledgedReportIds).toEqual([report.id]);
          expect(await instance.getAllocation(fixture.allocation.providerRef)).toMatchObject({
            pod,
            acknowledgementFresh: false,
          });
        } finally {
          clock.mockRestore();
        }
      });
    }
  );

  it.each(['missing_pod', 'wrong_revision', 'stale'] as const)(
    'does not acknowledge ignored registration: %s',
    async reason => {
      const fixture = await launchedAllocation();
      await runInDurableObject<OnPremInstallation, void>(fixture.stub, async instance => {
        const now =
          Math.max(Date.now(), fixture.report.observedAt) + (reason === 'stale' ? 61_000 : 0);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
        const report: OnPremReport = {
          ...fixture.report,
          ...(reason === 'missing_pod' ? { pod: undefined } : {}),
          ...(reason === 'wrong_revision' ? { revision: fixture.report.revision + 1 } : {}),
        };
        try {
          const result = await instance.exchange(
            fixture.installationId,
            fixture.credential,
            heartbeat([report])
          );
          expect(result.acknowledgedReportIds).toEqual([]);
          expect(await instance.getAllocation(fixture.allocation.providerRef)).toMatchObject({
            pod: null,
            acknowledgementFresh: false,
          });
        } finally {
          clock.mockRestore();
        }
      });
    }
  );

  it('replays accepted registration across eviction but not after Stop', async () => {
    const fixture = await launchedAllocation();
    const registered = await fixture.stub.exchange(
      fixture.installationId,
      fixture.credential,
      heartbeat([fixture.report])
    );
    expect(registered.acknowledgedReportIds).toEqual([fixture.report.id]);
    await abortAllDurableObjects();
    const stub = getOnPremInstallationStub(env, fixture.organizationId);
    expect(
      (await stub.exchange(fixture.installationId, fixture.credential, heartbeat([fixture.report])))
        .acknowledgedReportIds
    ).toEqual([fixture.report.id]);
    await stub.stopAllocation(fixture.allocation.providerRef);
    const stopped = await stub.exchange(
      fixture.installationId,
      fixture.credential,
      heartbeat([fixture.report])
    );
    expect(stopped.acknowledgedReportIds).toEqual([]);
    expect(stopped.operations[0]).toMatchObject({
      type: 'stop',
      allocationId: fixture.report.allocationId,
    });
    expect(await stub.getAllocation(fixture.allocation.providerRef)).toMatchObject({
      phase: 'stopping',
      pod,
    });
  });

  it('withholds registration acknowledgement when the Pod identity conflicts', async () => {
    const fixture = await launchedAllocation();
    await fixture.stub.exchange(
      fixture.installationId,
      fixture.credential,
      heartbeat([fixture.report])
    );
    const result = await fixture.stub.exchange(
      fixture.installationId,
      fixture.credential,
      heartbeat([
        {
          ...fixture.report,
          id: crypto.randomUUID(),
          observedAt: Math.max(Date.now(), fixture.report.observedAt + 1),
          pod: { ...pod, uid: 'pod-conflict' },
        },
      ])
    );
    expect(result.acknowledgedReportIds).toEqual([]);
    expect(result.operations[0]).toMatchObject({ type: 'stop', reason: 'pod_identity_mismatch' });
    expect(await fixture.stub.getAllocation(fixture.allocation.providerRef)).toMatchObject({
      phase: 'stopping',
      pod,
    });
  });
});
