import { describe, expect, it } from 'vitest';
import {
  decodeOnPremProviderRef,
  encodeOnPremProviderRef,
  onPremEnrollRequestSchema,
  onPremEnrollResponseSchema,
  onPremEnrollmentRequestSchema,
  onPremEnrollmentResponseSchema,
  onPremExchangeRequestSchema,
  onPremExchangeResponseSchema,
  onPremInstanceResourcesSchema,
  onPremInstanceTypeSchema,
  onPremInstanceTypesSchema,
  onPremOperationSchema,
  onPremOrganizationIdSchema,
  onPremProfileSchema,
  onPremProviderBindingSchema,
  onPremReportSchema,
  onPremRevokeRequestSchema,
  onPremSelectRequestSchema,
  onPremStatusSchema,
  type OnPremInstanceType,
  type OnPremOperation,
  type OnPremProfile,
  type OnPremReport,
} from './onprem-protocol.js';

const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const installationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const allocationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const providerRef = encodeOnPremProviderRef({ installationId, allocationId });
const now = Date.parse('2026-09-02T10:00:00.000Z');
const profile: OnPremProfile = {
  id: 'gvisor-small',
  revision: 'v1',
  runtimeClass: 'gvisor',
  image: 'registry.example/kilo/runtime:1',
  brokerUrl: 'https://broker.kilo.svc:8443',
  maxLifetimeMs: 3_600_000,
};
const operationBase = { id, allocationId, sandboxId: 'opaque:sandbox/1', providerRef, revision: 1 };
const launch: OnPremOperation = {
  ...operationBase,
  type: 'launch',
  profileId: profile.id,
  profileRevision: profile.revision,
  hardStopAt: now + profile.maxLifetimeMs,
  notAfter: now + 60_000,
  bootstrap: {
    SANDBOX_CONTROL_URL: 'wss://cloud.example/sandbox-control/1',
    SANDBOX_CONTROL_CREDENTIAL: 'allocation-scoped-test-capability',
    PROVIDER_INSTANCE_ID: providerRef,
    KILO_PLATFORM: 'cloud-agent',
    KILO_DISABLE_AUTOUPDATE: 'true',
    KILO_DEBUG_SESSION_INGEST: '1',
  },
};
const report: OnPremReport = { id, allocationId, revision: 1, observedAt: now, status: 'pending' };
const instanceType: OnPremInstanceType = {
  id: 'small',
  displayName: 'Small',
  resources: { cpuMillis: 1000, memoryMiB: 2048, diskMiB: 4096 },
};

describe('on-prem wire contracts', () => {
  it('round-trips compact refs and returns null for invalid input', () => {
    expect(providerRef).toBe(`onprem:v1:${installationId}:${allocationId}`);
    expect(decodeOnPremProviderRef(providerRef)).toEqual({ installationId, allocationId });
    for (const raw of [
      null,
      undefined,
      1,
      {},
      '',
      'x'.repeat(129),
      `onprem:v2:${installationId}:${allocationId}`,
      `vercel:v1:${installationId}:${allocationId}`,
      `onprem:v1:not-a-uuid:${allocationId}`,
      `onprem:v1:${installationId}:not-a-uuid`,
      `${providerRef}:extra`,
      `${providerRef}\n`,
    ]) {
      expect(decodeOnPremProviderRef(raw)).toBeNull();
    }
    expect(() => encodeOnPremProviderRef({ installationId, allocationId: 'invalid' })).toThrow();
  });

  it('canonicalizes UUIDs and refs without changing opaque identifiers', () => {
    const uppercaseRef = `onprem:v1:${installationId.toUpperCase()}:${allocationId.toUpperCase()}`;
    expect(onPremOrganizationIdSchema.parse(organizationId.toUpperCase())).toBe(organizationId);
    expect(onPremOrganizationIdSchema.safeParse('invalid').success).toBe(false);
    expect(
      encodeOnPremProviderRef({
        installationId: installationId.toUpperCase(),
        allocationId: allocationId.toUpperCase(),
      })
    ).toBe(providerRef);
    expect(decodeOnPremProviderRef(uppercaseRef)).toEqual({ installationId, allocationId });
    const binding = { kind: 'onprem', organizationId, installationId, profileId: 'GVisor-Small' };
    expect(
      onPremProviderBindingSchema.parse({
        ...binding,
        organizationId: organizationId.toUpperCase(),
        installationId: installationId.toUpperCase(),
      })
    ).toEqual(binding);
    expect(
      onPremOperationSchema.parse({
        ...launch,
        id: id.toUpperCase(),
        allocationId: allocationId.toUpperCase(),
        providerRef: uppercaseRef,
        sandboxId: 'Opaque:Sandbox/1',
      })
    ).toEqual({ ...launch, sandboxId: 'Opaque:Sandbox/1' });
    expect(
      onPremOperationSchema.safeParse({ ...launch, providerRef: uppercaseRef.toUpperCase() })
        .success
    ).toBe(false);
    expect(
      onPremReportSchema.parse({
        ...report,
        id: id.toUpperCase(),
        allocationId: allocationId.toUpperCase(),
      })
    ).toEqual(report);
  });

  it('requires a complete strict binding with UUID ownership', () => {
    const binding = { kind: 'onprem', organizationId, installationId, profileId: profile.id };
    expect(onPremProviderBindingSchema.parse(binding)).toEqual(binding);
    for (const change of [
      { organizationId: 'invalid' },
      { installationId: 'invalid' },
      { profileId: '' },
      { kind: 'cloudflare' },
      { pod: { uid: id } },
      { credential: 'not-public' },
    ]) {
      expect(onPremProviderBindingSchema.safeParse({ ...binding, ...change }).success).toBe(false);
    }
    expect(onPremProviderBindingSchema.safeParse({ kind: 'onprem', organizationId }).success).toBe(
      false
    );
  });

  it('bounds local profile identifiers and lifetime', () => {
    for (const maxLifetimeMs of [600_000, 86_400_000]) {
      expect(onPremProfileSchema.parse({ ...profile, maxLifetimeMs }).maxLifetimeMs).toBe(
        maxLifetimeMs
      );
    }
    for (const change of [
      { maxLifetimeMs: 599_999 },
      { maxLifetimeMs: 86_400_001 },
      { maxLifetimeMs: 600_000.5 },
      { revision: '' },
      { id: 'x'.repeat(129) },
      { runtimeClass: 'invalid..name' },
      { image: 'image --privileged' },
      { ready: true },
    ]) {
      expect(onPremProfileSchema.safeParse({ ...profile, ...change }).success).toBe(false);
    }
  });

  it('rejects broker URLs that are not HTTPS origins', () => {
    for (const brokerUrl of [profile.brokerUrl, `${profile.brokerUrl}/`, 'https://[::1]:8443']) {
      expect(onPremProfileSchema.parse({ ...profile, brokerUrl }).brokerUrl).toBe(brokerUrl);
    }
    for (const brokerUrl of [
      'not-a-url',
      'file:///broker',
      'http://broker.example',
      'https://broker.example/_kilo',
      'https://broker.example/gateway/..',
      'https://broker.example\\',
      'https://user:password@broker.example',
      'https://broker.example?token=private',
      'https://broker.example/#private',
      'https://broker.example?',
      'https://broker.example#',
    ]) {
      expect(onPremProfileSchema.safeParse({ ...profile, brokerUrl }).success).toBe(false);
    }
  });

  it('requires bounded integer instance resources without extra fields', () => {
    const bounds = [
      ['cpuMillis', 100, 8000],
      ['memoryMiB', 256, 16384],
      ['diskMiB', 512, 32768],
    ] as const;
    for (const [key, minimum, maximum] of bounds) {
      for (const value of [minimum, maximum]) {
        const resources = { ...instanceType.resources, [key]: value };
        expect(onPremInstanceResourcesSchema.parse(resources)).toEqual(resources);
      }
      for (const value of [minimum - 1, maximum + 1, minimum + 0.5, undefined, null, '1024']) {
        expect(
          onPremInstanceResourcesSchema.safeParse({ ...instanceType.resources, [key]: value })
            .success
        ).toBe(false);
      }
    }
    expect(
      onPremInstanceResourcesSchema.safeParse({ ...instanceType.resources, gpu: 1 }).success
    ).toBe(false);
  });

  it('validates strict instance descriptors and trims display names', () => {
    expect(onPremInstanceTypeSchema.parse({ ...instanceType, displayName: '  Small  ' })).toEqual(
      instanceType
    );
    expect(
      onPremInstanceTypeSchema.parse({
        ...instanceType,
        id: 'a'.repeat(63),
        displayName: 'a'.repeat(100),
      })
    ).toMatchObject({ id: 'a'.repeat(63), displayName: 'a'.repeat(100) });
    for (const id of [
      '',
      'Small',
      'small_type',
      'small.type',
      '-small',
      'small-',
      'a'.repeat(64),
    ]) {
      expect(onPremInstanceTypeSchema.safeParse({ ...instanceType, id }).success).toBe(false);
    }
    for (const change of [
      { displayName: '' },
      { displayName: ' \t\n ' },
      { displayName: 'a'.repeat(101) },
      { resources: undefined },
      { resources: { ...instanceType.resources, cpuMillis: 0 } },
      { selected: true },
    ]) {
      expect(onPremInstanceTypeSchema.safeParse({ ...instanceType, ...change }).success).toBe(
        false
      );
    }
  });

  it('accepts empty catalogs and bounds catalogs by count and unique IDs', () => {
    const instanceTypes = Array.from({ length: 32 }, (_, index) => ({
      ...instanceType,
      id: `size-${index}`,
    }));
    expect(onPremInstanceTypesSchema.parse([])).toEqual([]);
    expect(onPremInstanceTypesSchema.parse(instanceTypes)).toEqual(instanceTypes);
    expect(onPremInstanceTypesSchema.safeParse([...instanceTypes, instanceType]).success).toBe(
      false
    );
    expect(
      onPremInstanceTypesSchema.safeParse([
        instanceType,
        { ...instanceType, displayName: 'Another size' },
      ]).success
    ).toBe(false);
  });

  it('keeps status safe and does not deselect an unavailable installation', () => {
    const installation = {
      id: installationId,
      organizationId,
      name: 'Local cluster',
      state: 'offline',
      enrolledAt: '2026-09-02T10:00:00.000Z',
      lastSeenAt: null,
      runnerVersion: null,
      profile,
      diagnosticCode: 'runner_offline',
      activeAllocations: 1,
      cleanupPending: true,
    };
    expect(onPremStatusSchema.parse({ selected: true, installation })).toEqual({
      selected: true,
      installation: { ...installation, instanceTypes: [] },
    });
    expect(
      onPremStatusSchema.parse({
        selected: true,
        installation: { ...installation, instanceTypes: [instanceType] },
      }).installation?.instanceTypes
    ).toEqual([instanceType]);
    expect(
      onPremStatusSchema.parse({ selected: false, installation: null }).installation
    ).toBeNull();
    for (const change of [
      { credentialHash: 'a'.repeat(64) },
      { managementToken: 'not-public' },
      { enrolledAt: 'yesterday' },
      { diagnosticCode: 'Error: Bearer private' },
      { activeAllocations: -1 },
      { profile: { ...profile, credentials: {} } },
    ]) {
      expect(
        onPremStatusSchema.safeParse({
          selected: true,
          installation: { ...installation, ...change },
        }).success
      ).toBe(false);
    }
  });

  it('separates browser enrollment from the runner credential hash', () => {
    expect(onPremEnrollmentRequestSchema.parse({ name: 'Local cluster' })).toEqual({
      name: 'Local cluster',
    });
    expect(onPremEnrollmentRequestSchema.safeParse({ name: ' ' }).success).toBe(false);
    const enrollment = {
      installationId,
      organizationId,
      bootstrapToken: 'b'.repeat(43),
      expiresAt: '2026-09-02T10:10:00Z',
      protocolVersion: 1,
    };
    expect(onPremEnrollmentResponseSchema.parse(enrollment)).toEqual(enrollment);
    expect(
      onPremEnrollmentResponseSchema.safeParse({ ...enrollment, managementToken: 'private' })
        .success
    ).toBe(false);
    const request = {
      protocolVersion: 1,
      credentialHash: 'a'.repeat(64),
      runnerVersion: '1.0.0+test',
      profile,
    };
    expect(onPremEnrollRequestSchema.parse(request)).toEqual(request);
    for (const change of [
      { credentialHash: 'a'.repeat(63) },
      { credentialHash: 'a'.repeat(65) },
      { credentialHash: 'g'.repeat(64) },
      { protocolVersion: 2 },
      { managementToken: 'private' },
      { credentialHash: undefined },
    ]) {
      expect(onPremEnrollRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
    }
    expect(onPremEnrollResponseSchema.parse({ protocolVersion: 1, installationId })).toEqual({
      protocolVersion: 1,
      installationId,
    });
  });

  it('requires explicit selection and keeps revocation installation-scoped', () => {
    const selection = { installationId, profileId: profile.id, selected: false };
    expect(onPremSelectRequestSchema.parse(selection)).toEqual(selection);
    expect(
      onPremSelectRequestSchema.safeParse({ installationId, profileId: profile.id }).success
    ).toBe(false);
    expect(onPremRevokeRequestSchema.parse({ installationId })).toEqual({ installationId });
    expect(
      onPremRevokeRequestSchema.safeParse({ installationId, managementToken: 'private' }).success
    ).toBe(false);
  });

  it('accepts only launch and stop operations for the referenced allocation', () => {
    expect(onPremOperationSchema.parse(launch)).toEqual(launch);
    const stop = { ...operationBase, type: 'stop', reason: 'user_requested' };
    expect(onPremOperationSchema.parse(stop)).toEqual(stop);
    for (const change of [
      { type: 'reserve' },
      { allocationId: installationId },
      { providerRef: 'invalid' },
      { sandboxId: 'x'.repeat(257) },
      { revision: 0.5 },
      { hardStopAt: Infinity },
      { networkPolicy: {} },
      { pod: { namespace: 'kilo' } },
    ]) {
      expect(onPremOperationSchema.safeParse({ ...launch, ...change }).success).toBe(false);
    }
    expect(onPremOperationSchema.safeParse({ ...stop, bootstrap: {} }).success).toBe(false);
    for (const bootstrap of [
      { KUBECONFIG: 'private' },
      { ONPREM_MANAGEMENT_TOKEN: 'private' },
      { GITHUB_TOKEN: 'private' },
      { OPENAI_API_KEY: 'private' },
      { NETWORK_POLICY: {} },
      { SANDBOX_CONTROL_CREDENTIAL: 'x'.repeat(4097) },
      { KILO_PLATFORM: 'a\0b' },
    ]) {
      expect(onPremOperationSchema.safeParse({ ...launch, bootstrap }).success).toBe(false);
    }
  });

  it('validates report identity and safe diagnostics without inferring terminal state', () => {
    const pod = { namespace: 'kilo', name: 'allocation-1', uid: id, ip: '10.0.0.1' };
    for (const status of ['pending', 'active', 'terminal', 'unknown', 'rejected']) {
      const value = { ...report, status, pod };
      expect(onPremReportSchema.parse(value)).toEqual(value);
    }
    for (const change of [
      { status: 'missing' },
      { observedAt: -1 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { diagnosticCode: 'Error: private response' },
      { diagnosticCode: 'x'.repeat(65) },
      { pod: { ...pod, ip: 'not-an-ip' } },
      { pod: { ...pod, token: 'private' } },
    ]) {
      expect(onPremReportSchema.safeParse({ ...report, ...change }).success).toBe(false);
    }
  });

  it('bounds exchange batches and requires an explicit preflight result', () => {
    const reports = Array.from({ length: 32 }, () => report);
    const request = {
      protocolVersion: 1,
      runnerVersion: '1.0.0',
      ready: false,
      diagnosticCode: 'preflight_failed',
      reports,
    };
    expect(onPremExchangeRequestSchema.parse(request)).toEqual(request);
    for (const instanceTypes of [
      [],
      [
        instanceType,
        {
          id: 'large',
          displayName: 'Large',
          resources: { cpuMillis: 4000, memoryMiB: 8192, diskMiB: 16384 },
        },
      ],
    ]) {
      const advertised = { ...request, instanceTypes };
      expect(onPremExchangeRequestSchema.parse(advertised)).toEqual(advertised);
    }
    for (const change of [
      { instanceTypes: null },
      { instanceTypes: [instanceType, instanceType] },
      { reports: [...reports, report] },
      { ready: undefined },
      { protocolVersion: 2 },
    ]) {
      expect(onPremExchangeRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
    }
    const operations = Array.from({ length: 32 }, () => launch);
    const acknowledgedReportIds = reports.map(value => value.id);
    const response = {
      protocolVersion: 1,
      serverTime: now,
      revoked: false,
      acknowledgedReportIds,
      operations,
      pollAfterMs: 1000,
    };
    expect(onPremExchangeResponseSchema.parse(response)).toEqual(response);
    for (const change of [
      { operations: [...operations, launch] },
      { acknowledgedReportIds: [...acknowledgedReportIds, id] },
      { pollAfterMs: 0 },
      { pollAfterMs: 60_001 },
      { serverTime: NaN },
      { managementToken: 'private' },
    ]) {
      expect(onPremExchangeResponseSchema.safeParse({ ...response, ...change }).success).toBe(
        false
      );
    }
  });
});
