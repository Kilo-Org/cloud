import { describe, expect, it, vi } from 'vitest';
import type { VercelSandboxResources } from '@kilocode/worker-utils/sandbox-allocation';
import type { SandboxId, SandboxInstance } from './types.js';
import type { SessionMetadata } from './persistence/session-metadata.js';
import {
  assertSandboxBillingAllocation,
  billingCapacityForSandboxClass,
  buildSandboxBillingInput,
  configureSandboxBillingInput,
  CONTAINERS_BILLING_CAPACITIES,
  containersBillingIdentity,
  forceDestroyControlPlaneSandbox,
  getSandboxBillingRuntimeStatus,
  isContainersBillingClassName,
  isVercelBillingClassName,
  SANDBOX_CAPACITIES,
  SANDBOX_USAGE_SKUS,
  VERCEL_BILLING_CAPACITIES,
  vercelBillingIdentity,
  type SandboxClassName,
} from './container-usage-context.js';

function metadata(identity: SessionMetadata['identity']): SessionMetadata {
  return {
    metadataSchemaVersion: 2,
    identity,
    auth: {},
    repository: { type: 'github', repo: 'Kilo-Org/cloud' },
    lifecycle: { version: 1, timestamp: 1 },
  };
}

describe('container usage context', () => {
  it('invokes billing status as a binding method for RPC proxies', async () => {
    const status = {
      sandboxClassName: 'SandboxSmall' as const,
      running: true,
      blocked: false,
    };
    const getBillingRuntimeStatus = new Proxy(
      vi.fn(async () => status),
      {
        get: (target, property, receiver) => {
          if (property === 'call')
            throw new Error('RPC method proxies do not support Function.call');
          return Reflect.get(target, property, receiver);
        },
      }
    );

    await expect(
      getSandboxBillingRuntimeStatus({ getBillingRuntimeStatus } as unknown as SandboxInstance)
    ).resolves.toEqual(status);
  });

  it('invokes native control-plane destruction as a binding method without SDK fallback', async () => {
    const forceDestroyForControlPlane = new Proxy(
      vi.fn(async function (this: { running: boolean }) {
        this.running = false;
      }),
      {
        get: (target, property, receiver) => {
          if (property === 'call' || property === 'apply') {
            throw new Error('RPC method proxies do not support Function.call or Function.apply');
          }
          return Reflect.get(target, property, receiver);
        },
      }
    );
    const sandbox = {
      running: true,
      forceDestroyForControlPlane,
      destroy: vi.fn(),
    };

    await expect(forceDestroyControlPlaneSandbox(sandbox)).resolves.toBeUndefined();

    expect(sandbox.running).toBe(false);
    expect(forceDestroyForControlPlane).toHaveBeenCalledOnce();
    expect(sandbox.destroy).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 42, {}, { forceDestroyForControlPlane: true }])(
    'fails closed when native control-plane destruction is unavailable: %j',
    async sandbox => {
      await expect(forceDestroyControlPlaneSandbox(sandbox)).rejects.toThrow(
        'Cloudflare control-plane native destruction is unavailable'
      );
    }
  );

  it('does not substitute SDK destruction for a missing native capability', async () => {
    const sandbox = { destroy: vi.fn(async () => undefined) };

    await expect(forceDestroyControlPlaneSandbox(sandbox)).rejects.toThrow(
      'Cloudflare control-plane native destruction is unavailable'
    );
    expect(sandbox.destroy).not.toHaveBeenCalled();
  });

  it('propagates native control-plane destruction failures', async () => {
    const error = new Error('Native destroy acknowledgement lost');
    const sandbox = {
      forceDestroyForControlPlane: vi.fn().mockRejectedValue(error),
      destroy: vi.fn(),
    };

    await expect(forceDestroyControlPlaneSandbox(sandbox)).rejects.toBe(error);
    expect(sandbox.destroy).not.toHaveBeenCalled();
  });

  it('maps every concrete sandbox class to its immutable SKU', () => {
    expect(SANDBOX_USAGE_SKUS).toEqual({
      Sandbox: 'cloud-agent-standard-2026-07',
      SandboxContainment: 'cloud-agent-standard-2026-07',
      SandboxSmall: 'cloud-agent-small-2026-07',
      SandboxSmallContainment: 'cloud-agent-small-2026-07',
      SandboxDIND: 'cloud-agent-dind-2026-07',
      SandboxCodeReview: 'cloud-agent-code-review-2026-07',
      SandboxCodeReviewContainment: 'cloud-agent-code-review-2026-07',
      SandboxContainersStandard3: 'cloud-agent-containers-standard-3-2026-09',
      SandboxContainersStandard4: 'cloud-agent-containers-standard-4-2026-09',
      SandboxVercelSmall: 'cloud-agent-vercel-small-2026-09',
      SandboxVercelLarge: 'cloud-agent-vercel-large-2026-09',
    });
  });

  it('resolves a containers identity per instance size', () => {
    expect(containersBillingIdentity('standard-3')).toEqual({
      className: 'SandboxContainersStandard3',
      service: 'cloud-agent-next-sandbox-containers-standard3',
      sku: 'cloud-agent-containers-standard-3-2026-09',
      capacity: { vcpu: 2, memoryMiB: 8_192, diskMB: 16_000 },
    });
    expect(containersBillingIdentity('standard-4')).toEqual({
      className: 'SandboxContainersStandard4',
      service: 'cloud-agent-next-sandbox-containers-standard4',
      sku: 'cloud-agent-containers-standard-4-2026-09',
      capacity: { vcpu: 4, memoryMiB: 12_288, diskMB: 20_000 },
    });

    expect(() => containersBillingIdentity('lite')).toThrow(
      'Containers billing is unsupported for instance size: lite'
    );
    expect(() => containersBillingIdentity('standard-1')).toThrow(
      'Containers billing is unsupported for instance size: standard-1'
    );
    expect(() => containersBillingIdentity('standard-2')).toThrow(
      'Containers billing is unsupported for instance size: standard-2'
    );

    for (const instance of ['constructor', 'toString', '__proto__', 'standard-5']) {
      expect(() => containersBillingIdentity(instance)).toThrow(
        `Containers billing is unsupported for instance size: ${instance}`
      );
    }
  });

  it('does not classify inherited object keys as containers billing classes', () => {
    for (const className of ['toString', 'constructor', 'valueOf', '__proto__'] as const) {
      expect(isContainersBillingClassName(className as SandboxClassName)).toBe(false);
    }
  });

  it('classifies exactly the own Vercel billing classes', () => {
    for (const className of ['SandboxVercelSmall', 'SandboxVercelLarge'] as const) {
      expect(isVercelBillingClassName(className)).toBe(true);
    }
    for (const className of [
      'Sandbox',
      'SandboxContainment',
      'SandboxSmall',
      'SandboxSmallContainment',
      'SandboxDIND',
      'SandboxCodeReview',
      'SandboxCodeReviewContainment',
      'SandboxContainersStandard3',
      'SandboxContainersStandard4',
    ] as const) {
      expect(isVercelBillingClassName(className)).toBe(false);
    }
    for (const className of ['toString', 'constructor', 'valueOf', '__proto__'] as const) {
      expect(isVercelBillingClassName(className as SandboxClassName)).toBe(false);
    }
  });

  it('snapshots the Vercel capacities without a disk field', () => {
    expect(VERCEL_BILLING_CAPACITIES).toEqual({
      SandboxVercelSmall: { vcpu: 2, memoryMiB: 4_096 },
      SandboxVercelLarge: { vcpu: 4, memoryMiB: 8_192 },
    });
    for (const capacity of Object.values(VERCEL_BILLING_CAPACITIES)) {
      expect(capacity).not.toHaveProperty('diskMB');
      expect(capacity).not.toHaveProperty('disk_mb');
    }
  });

  it('resolves a Vercel identity for both accepted presets', () => {
    const small: VercelSandboxResources = { vcpus: 2, memory: 4096 };
    const large: VercelSandboxResources = { vcpus: 4, memory: 8192 };

    expect(vercelBillingIdentity(small)).toEqual({
      className: 'SandboxVercelSmall',
      service: 'cloud-agent-next-sandbox-vercel-small',
      sku: 'cloud-agent-vercel-small-2026-09',
      capacity: { vcpu: 2, memoryMiB: 4_096 },
    });
    expect(vercelBillingIdentity(large)).toEqual({
      className: 'SandboxVercelLarge',
      service: 'cloud-agent-next-sandbox-vercel-large',
      sku: 'cloud-agent-vercel-large-2026-09',
      capacity: { vcpu: 4, memoryMiB: 8_192 },
    });
  });

  it('throws instead of guessing a SKU for unsupported Vercel resources', () => {
    for (const resources of [
      { vcpus: 1, memory: 2048 },
      { vcpus: 2, memory: 8192 },
      { vcpus: 4, memory: 4096 },
      { vcpus: 8, memory: 16384 },
    ]) {
      expect(() => vercelBillingIdentity(resources as VercelSandboxResources)).toThrow(
        `Vercel billing is unsupported for resources: ${resources.vcpus}:${resources.memory}`
      );
    }
  });

  it('routes the capacity lookup to Vercel, containers, and legacy records', () => {
    expect(billingCapacityForSandboxClass('SandboxVercelSmall')).toEqual({
      vcpu: 2,
      memoryMiB: 4_096,
    });
    expect(billingCapacityForSandboxClass('SandboxVercelLarge')).toEqual({
      vcpu: 4,
      memoryMiB: 8_192,
    });
    expect(billingCapacityForSandboxClass('SandboxContainersStandard3')).toEqual(
      CONTAINERS_BILLING_CAPACITIES.SandboxContainersStandard3
    );
    expect(billingCapacityForSandboxClass('SandboxSmall')).toEqual(SANDBOX_CAPACITIES.SandboxSmall);
  });

  it('accepts both Vercel classes against an isolated `ses` billing ID and rejects others', () => {
    const vercelClasses = ['SandboxVercelSmall', 'SandboxVercelLarge'] as const;
    const attribution = {
      subject: { type: 'user', id: 'user_vercel' },
      actor: { type: 'user', id: 'user_vercel' },
      sessionId: 'agent_1',
      metadata: { origin: 'cloud-agent' },
    } as const;

    for (const sandboxClassName of vercelClasses) {
      expect(() =>
        assertSandboxBillingAllocation(sandboxClassName, {
          sandboxId: 'ses-abcdef',
          ...attribution,
        })
      ).not.toThrow();

      for (const sandboxId of ['abcdef' as SandboxId, 'istd-abcdef' as SandboxId]) {
        expect(() =>
          assertSandboxBillingAllocation(sandboxClassName, { sandboxId, ...attribution })
        ).toThrow(`${sandboxClassName} billing received an incompatible sandbox ID`);
      }
    }
  });

  it('classifies exactly the own containers billing classes', () => {
    for (const className of ['SandboxContainersStandard3', 'SandboxContainersStandard4'] as const) {
      expect(isContainersBillingClassName(className)).toBe(true);
    }
    for (const className of [
      'Sandbox',
      'SandboxContainment',
      'SandboxSmall',
      'SandboxSmallContainment',
      'SandboxDIND',
      'SandboxCodeReview',
      'SandboxCodeReviewContainment',
    ] as const) {
      expect(isContainersBillingClassName(className)).toBe(false);
    }
  });

  it('agrees with containers identity resolution for every resolved class name', () => {
    for (const instance of ['standard-3', 'standard-4'] as const) {
      const { className } = containersBillingIdentity(instance);
      expect(isContainersBillingClassName(className)).toBe(true);
    }
  });

  it('never resolves an inherited object key as a sandbox billing capacity', () => {
    for (const className of ['toString', 'constructor', 'valueOf'] as const) {
      expect(isContainersBillingClassName(className as SandboxClassName)).toBe(false);
      expect(billingCapacityForSandboxClass(className as SandboxClassName)).not.toHaveProperty(
        'vcpu'
      );
    }
  });

  it('accepts a containers class against an isolated `ses` billing ID and rejects a bare ID', () => {
    const containersClasses = ['SandboxContainersStandard3', 'SandboxContainersStandard4'] as const;
    const attribution = {
      subject: { type: 'user', id: 'user_containers' },
      actor: { type: 'user', id: 'user_containers' },
      sessionId: 'agent_1',
      metadata: { origin: 'cloud-agent' },
    } as const;

    for (const sandboxClassName of containersClasses) {
      expect(() =>
        assertSandboxBillingAllocation(sandboxClassName, {
          sandboxId: 'ses-abcdef',
          ...attribution,
        })
      ).not.toThrow();

      for (const sandboxId of ['abcdef' as SandboxId, 'org-abcdef' as SandboxId]) {
        expect(() =>
          assertSandboxBillingAllocation(sandboxClassName, { sandboxId, ...attribution })
        ).toThrow(`${sandboxClassName} billing received an incompatible sandbox ID`);
      }
    }
  });

  it('snapshots the configured capacity for every legacy sandbox class', () => {
    expect(SANDBOX_CAPACITIES).toEqual({
      Sandbox: { vcpu: 4, memoryMiB: 12_288, diskMB: 20_000 },
      SandboxContainment: { vcpu: 4, memoryMiB: 12_288, diskMB: 20_000 },
      SandboxSmall: { vcpu: 2, memoryMiB: 6_144, diskMB: 10_000 },
      SandboxSmallContainment: { vcpu: 2, memoryMiB: 6_144, diskMB: 10_000 },
      SandboxDIND: { vcpu: 2, memoryMiB: 6_144, diskMB: 10_000 },
      SandboxCodeReview: { vcpu: 1, memoryMiB: 4_096, diskMB: 8_000 },
      SandboxCodeReviewContainment: { vcpu: 1, memoryMiB: 4_096, diskMB: 8_000 },
    });
  });

  it('keeps the containers billing capacities unchanged', () => {
    expect(CONTAINERS_BILLING_CAPACITIES).toEqual({
      SandboxContainersStandard3: { vcpu: 2, memoryMiB: 8_192, diskMB: 16_000 },
      SandboxContainersStandard4: { vcpu: 4, memoryMiB: 12_288, diskMB: 20_000 },
    });
  });

  it.each([
    {
      name: 'personal human',
      identity: { sessionId: 'agent_personal', userId: 'user_personal' },
      expected: {
        subject: { type: 'user', id: 'user_personal' },
        actor: { type: 'user', id: 'user_personal' },
      },
    },
    {
      name: 'organization human',
      identity: { sessionId: 'agent_org', userId: 'user_org', orgId: 'org_1' },
      expected: {
        subject: { type: 'org', id: 'org_1' },
        actor: { type: 'user', id: 'user_org' },
      },
    },
    {
      name: 'personal bot',
      identity: { sessionId: 'agent_bot', userId: 'user_bot', botId: 'bot_1' },
      expected: {
        subject: { type: 'user', id: 'user_bot' },
        actor: { type: 'bot', id: 'bot_1' },
        onBehalfOf: { type: 'user', id: 'user_bot' },
      },
    },
    {
      name: 'organization bot',
      identity: {
        sessionId: 'agent_org_bot',
        userId: 'user_org_bot',
        orgId: 'org_2',
        botId: 'bot_2',
      },
      expected: {
        subject: { type: 'org', id: 'org_2' },
        actor: { type: 'bot', id: 'bot_2' },
        onBehalfOf: { type: 'org', id: 'org_2' },
      },
    },
  ])('derives trusted $name attribution', ({ identity, expected }) => {
    expect(buildSandboxBillingInput(metadata(identity), 'ses-abcdef')).toMatchObject(expected);
  });

  it('keeps isolated metadata bounded and normalizes automation origins', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_security',
        userId: 'user_security',
        orgId: 'org_security',
        billingOrigin: 'security-remediation',
      }),
      'crv-abcdef'
    );

    expect(input).toMatchObject({
      sandboxId: 'crv-abcdef',
      sessionId: 'agent_security',
      metadata: { origin: 'security-remediation' },
    });
    expect(JSON.stringify(input)).not.toContain('Kilo-Org/cloud');
  });

  it.each(['scheduled', 'webhook'])(
    'attributes isolated Standard %s usage to the session',
    origin => {
      const input = buildSandboxBillingInput(
        metadata({
          sessionId: `agent_${origin}`,
          userId: 'user_standard',
          orgId: 'org_standard',
          billingOrigin: origin,
        }),
        'istd-abcdef'
      );

      expect(input).toMatchObject({
        sandboxId: 'istd-abcdef',
        sessionId: `agent_${origin}`,
        metadata: { origin },
      });
    }
  );

  it('omits session, origin, and repository metadata for shared containers', () => {
    const first = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_first',
        userId: 'user_shared',
        orgId: 'org_shared',
        billingOrigin: 'security-agent',
      }),
      'org-abcdef'
    );
    const second = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_second',
        userId: 'user_shared',
        orgId: 'org_shared',
        billingOrigin: 'cloud-agent-web',
      }),
      'org-abcdef'
    );

    expect(first).toEqual(second);
    expect(first).toEqual({
      sandboxId: 'org-abcdef',
      subject: { type: 'org', id: 'org_shared' },
      actor: { type: 'user', id: 'user_shared' },
    });
  });

  it('maps unknown caller-provided origins to other', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_unknown',
        userId: 'user_unknown',
        billingOrigin: 'attacker-controlled-value',
      }),
      'dind-abcdef'
    );
    expect(input.metadata?.origin).toBe('other');
  });

  it('does not positively attribute legacy metadata without a trusted billing origin', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_legacy',
        userId: 'user_legacy',
        createdOnPlatform: 'code-review',
      }),
      'crv-legacy'
    );
    expect(input.metadata?.origin).toBe('other');
  });

  it('does not trust the public createdOnPlatform label as billing origin', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_public',
        userId: 'user_public',
        createdOnPlatform: 'security-remediation',
        billingOrigin: 'cloud-agent',
      }),
      'ses-abcdef'
    );
    expect(input.metadata?.origin).toBe('cloud-agent');
  });

  it('rejects session attribution and extra metadata for shared sandboxes', () => {
    expect(() =>
      assertSandboxBillingAllocation('Sandbox', {
        sandboxId: 'org-abcdef',
        subject: { type: 'user', id: 'user_shared' },
        actor: { type: 'user', id: 'user_shared' },
        sessionId: 'agent_leak',
        metadata: { origin: 'cloud-agent' },
      })
    ).toThrow('Shared sandbox billing cannot contain session attribution');
  });

  it('rejects isolated-prefixed legacy IDs for shared sandbox classes', () => {
    expect(() =>
      assertSandboxBillingAllocation('Sandbox', {
        sandboxId: 'ses-abcdef__legacy',
        subject: { type: 'user', id: 'user_shared' },
        actor: { type: 'user', id: 'user_shared' },
      })
    ).toThrow('Shared sandbox billing requires a shared sandbox ID');
  });

  it('requires bounded isolated attribution for non-shared sandbox classes', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxSmall', {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_isolated' },
        actor: { type: 'user', id: 'user_isolated' },
        metadata: { origin: 'cloud-agent' },
      })
    ).toThrow('Isolated sandbox billing requires session attribution');
  });

  it.each(['Sandbox', 'SandboxContainment'] as const)(
    'accepts isolated Standard attribution for %s',
    sandboxClassName => {
      expect(() =>
        assertSandboxBillingAllocation(sandboxClassName, {
          sandboxId: 'istd-abcdef',
          subject: { type: 'org', id: 'org_standard' },
          actor: { type: 'user', id: 'user_standard' },
          sessionId: 'agent_standard',
          metadata: { origin: 'scheduled' },
        })
      ).not.toThrow();
    }
  );

  it('requires session attribution for isolated Standard sandboxes', () => {
    expect(() =>
      assertSandboxBillingAllocation('Sandbox', {
        sandboxId: 'istd-abcdef',
        subject: { type: 'org', id: 'org_standard' },
        actor: { type: 'user', id: 'user_standard' },
        metadata: { origin: 'webhook' },
      })
    ).toThrow('Isolated sandbox billing requires session attribution');
  });

  it('rejects unsupported isolated origins at the sandbox RPC boundary', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxSmall', {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_isolated' },
        actor: { type: 'user', id: 'user_isolated' },
        sessionId: 'agent_1',
        metadata: { origin: 'forged-origin' },
      })
    ).toThrow('Isolated sandbox billing origin is unsupported');
  });

  it('rejects a sandbox ID that does not match the concrete container class', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxDIND', {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: 'agent_1',
        metadata: { origin: 'cloud-agent' },
      })
    ).toThrow('SandboxDIND billing received an incompatible sandbox ID');
  });

  it('rejects isolated Standard IDs for Small container classes', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxSmall', {
        sandboxId: 'istd-abcdef',
        subject: { type: 'user', id: 'user_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: 'agent_1',
        metadata: { origin: 'cloud-agent' },
      })
    ).toThrow('SandboxSmall billing received an incompatible sandbox ID');
  });

  it('skips shadow configuration when a sandbox does not expose the metering RPC', async () => {
    await expect(
      configureSandboxBillingInput({} as SandboxInstance, {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: 'agent_1',
        metadata: { origin: 'cloud-agent' },
      })
    ).resolves.toBeUndefined();
  });

  it('propagates attribution configuration failures before sandbox startup', async () => {
    const configureBilling = vi.fn().mockRejectedValue(new Error('meter unavailable'));
    await expect(
      configureSandboxBillingInput({ configureBilling } as unknown as SandboxInstance, {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: 'agent_1',
        metadata: { origin: 'cloud-agent' },
      })
    ).rejects.toThrow('meter unavailable');
    expect(configureBilling).toHaveBeenCalledOnce();
  });
});
