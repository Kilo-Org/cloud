import { describe, expect, it } from 'vitest';
import type { VercelSandboxResources } from '@kilocode/worker-utils/sandbox-allocation';
import type { SandboxId } from './types.js';
import type { SessionMetadata } from './persistence/session-metadata.js';
import {
  assertSandboxBillingAllocation,
  billingCapacityForSandboxClass,
  buildSandboxBillingInput,
  parseSandboxBillingInput,
  CONTAINERS_BILLING_CAPACITIES,
  containersBillingIdentity,
  isContainersBillingClassName,
  isVercelBillingClassName,
  SANDBOX_CAPACITIES,
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
  it('bills the code-review containers instance at the code-review capacity', () => {
    expect(containersBillingIdentity('code-review')).toEqual({
      className: 'SandboxContainersCodeReview',
      service: 'cloud-agent-next-sandbox-containers-code-review',
      sku: 'cloud-agent-code-review-2026-07',
      capacity: { vcpu: 1, memoryMiB: 4_096, diskMB: 8_000 },
    });
  });

  it('rejects unsupported containers instance sizes', () => {
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
      'SandboxContainment',
      'SandboxSmallContainment',
      'SandboxContainersStandard3',
      'SandboxContainersStandard4',
    ] as const) {
      expect(isVercelBillingClassName(className)).toBe(false);
    }
    for (const className of ['toString', 'constructor', 'valueOf', '__proto__'] as const) {
      expect(isVercelBillingClassName(className as SandboxClassName)).toBe(false);
    }
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
    expect(billingCapacityForSandboxClass('SandboxVercelSmall')).toEqual(
      VERCEL_BILLING_CAPACITIES.SandboxVercelSmall
    );
    expect(billingCapacityForSandboxClass('SandboxVercelLarge')).toEqual(
      VERCEL_BILLING_CAPACITIES.SandboxVercelLarge
    );
    expect(billingCapacityForSandboxClass('SandboxContainersStandard3')).toEqual(
      CONTAINERS_BILLING_CAPACITIES.SandboxContainersStandard3
    );
    expect(billingCapacityForSandboxClass('SandboxSmallContainment')).toEqual(
      SANDBOX_CAPACITIES.SandboxSmallContainment
    );
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
    for (const className of ['SandboxContainment', 'SandboxSmallContainment'] as const) {
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

  it('attributes Agent Manager sessions to agent-manager', () => {
    const input = buildSandboxBillingInput(
      metadata({
        sessionId: 'agent_manager',
        userId: 'user_manager',
        billingOrigin: 'agent-manager',
      }),
      'dind-abcdef'
    );
    expect(input.metadata?.origin).toBe('agent-manager');
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

  it.each([
    ['isolated', 'SandboxSmallContainment', true],
    ['code-review', 'SandboxContainersCodeReview', true],
    ['shared', 'SandboxContainment', false],
  ] as const)(
    'attributes a placed %s sandbox from its kind, not its neutral key',
    (sandboxKind, className, sessionScoped) => {
      const sandboxId = `sbx-${'a'.repeat(48)}` as SandboxId;
      const input = buildSandboxBillingInput(
        {
          ...metadata({
            sessionId: 'workspace_placed',
            userId: 'user_placed',
            billingOrigin: 'cloud-agent',
          }),
          workspace: { sandboxId, sandboxProvider: 'cloudflare', sandboxKind },
        },
        sandboxId
      );

      expect(input.sandboxKind).toBe(sandboxKind);
      expect(input.sessionId).toBe(sessionScoped ? 'workspace_placed' : undefined);
      expect(() => assertSandboxBillingAllocation(className, input)).not.toThrow();
      // The kind survives the strict envelope without reaching the usage context.
      expect(parseSandboxBillingInput(input)).toEqual(input);
    }
  );

  it('rejects placed billing without its kind and legacy billing with one', () => {
    const attribution = {
      sandboxId: `sbx-${'a'.repeat(48)}` as SandboxId,
      subject: { type: 'user', id: 'user_placed' },
      actor: { type: 'user', id: 'user_placed' },
      sessionId: 'workspace_placed',
      metadata: { origin: 'cloud-agent' },
    } as const;

    expect(() => assertSandboxBillingAllocation('SandboxSmallContainment', attribution)).toThrow(
      'Sandbox key and kind do not match'
    );
    expect(() =>
      assertSandboxBillingAllocation('SandboxSmallContainment', {
        ...attribution,
        sandboxId: 'ses-abcdef' as SandboxId,
        sandboxKind: 'isolated',
      })
    ).toThrow('Sandbox key and kind do not match');
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
      assertSandboxBillingAllocation('SandboxContainment', {
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
      assertSandboxBillingAllocation('SandboxContainment', {
        sandboxId: 'ses-abcdef__legacy',
        subject: { type: 'user', id: 'user_shared' },
        actor: { type: 'user', id: 'user_shared' },
      })
    ).toThrow('Shared sandbox billing requires a shared sandbox ID');
  });

  it('requires bounded isolated attribution for non-shared sandbox classes', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxSmallContainment', {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_isolated' },
        actor: { type: 'user', id: 'user_isolated' },
        metadata: { origin: 'cloud-agent' },
      })
    ).toThrow('Isolated sandbox billing requires session attribution');
  });

  it.each(['SandboxContainment'] as const)(
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
      assertSandboxBillingAllocation('SandboxContainment', {
        sandboxId: 'istd-abcdef',
        subject: { type: 'org', id: 'org_standard' },
        actor: { type: 'user', id: 'user_standard' },
        metadata: { origin: 'webhook' },
      })
    ).toThrow('Isolated sandbox billing requires session attribution');
  });

  it('rejects unsupported isolated origins at the sandbox RPC boundary', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxSmallContainment', {
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
      assertSandboxBillingAllocation('SandboxContainment', {
        sandboxId: 'ses-abcdef',
        subject: { type: 'user', id: 'user_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: 'agent_1',
        metadata: { origin: 'cloud-agent' },
      })
    ).toThrow('SandboxContainment billing received an incompatible sandbox ID');
  });

  it('rejects isolated Standard IDs for Small container classes', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxSmallContainment', {
        sandboxId: 'istd-abcdef',
        subject: { type: 'user', id: 'user_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: 'agent_1',
        metadata: { origin: 'cloud-agent' },
      })
    ).toThrow('SandboxSmallContainment billing received an incompatible sandbox ID');
  });
  it('drops the retired enforcement flag from persisted billing input', () => {
    const input = {
      sandboxId: 'ses-abcdef',
      subject: { type: 'user', id: 'user_1' },
      actor: { type: 'user', id: 'user_1' },
      sessionId: 'agent_1',
      metadata: { origin: 'cloud-agent' },
    };
    expect(parseSandboxBillingInput({ ...input, enforcementRequested: true })).toEqual(input);
  });
});
