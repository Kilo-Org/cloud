import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

import { CLOUDFLARE_CONTAINERS_INSTANCES } from '@kilocode/worker-utils/sandbox-allocation';

import { containerCapacityForService } from '../../../apps/web/src/lib/cloudflare/container-capacity.js';
import {
  CONTAINERS_BILLING_CAPACITIES,
  containersBillingIdentity,
  SANDBOX_CAPACITIES,
  usageServiceForSandboxClass,
  type LegacySandboxClassName,
} from './container-usage-context.js';

type UnmeteredSandboxClassName = 'SandboxContainers';

type WranglerContainer = {
  class_name: LegacySandboxClassName | UnmeteredSandboxClassName;
  instance_type?: {
    vcpu: number;
    memory_mib: number;
    disk_mb: number;
  };
};

type MeteredWranglerContainer = {
  class_name: LegacySandboxClassName;
  instance_type: {
    vcpu: number;
    memory_mib: number;
    disk_mb: number;
  };
};

type WranglerConfig = {
  containers: WranglerContainer[];
};

const SERVICE_BY_CLASS: Record<LegacySandboxClassName, string> = {
  Sandbox: 'cloud-agent-next-sandbox',
  SandboxContainment: 'cloud-agent-next-sandbox-containment',
  SandboxSmall: 'cloud-agent-next-sandbox-small',
  SandboxSmallContainment: 'cloud-agent-next-sandbox-small-containment',
  SandboxDIND: 'cloud-agent-next-sandbox-dind',
  SandboxCodeReview: 'cloud-agent-next-sandbox-code-review',
  SandboxCodeReviewContainment: 'cloud-agent-next-sandbox-code-review-containment',
};

function isMeteredContainer(container: WranglerContainer): container is MeteredWranglerContainer {
  return container.class_name !== 'SandboxContainers';
}

describe('production container capacity parity', () => {
  it('keeps Wrangler, usage metadata, and web reconciliation capacities aligned', () => {
    const config = parse(
      fs.readFileSync(path.join(process.cwd(), 'wrangler.jsonc'), 'utf8')
    ) as WranglerConfig;

    const unmetered = config.containers.filter(container => !isMeteredContainer(container));
    expect(unmetered).toHaveLength(1);
    expect(unmetered[0]?.class_name).toBe('SandboxContainers');
    expect(unmetered[0]?.instance_type).toBeUndefined();
    expect('SandboxContainers' in SANDBOX_CAPACITIES).toBe(false);

    const metered = config.containers.filter(isMeteredContainer);
    const classNames = metered.map(container => container.class_name);
    expect(new Set(classNames)).toEqual(new Set(Object.keys(SANDBOX_CAPACITIES)));
    expect(classNames).toHaveLength(Object.keys(SANDBOX_CAPACITIES).length);

    for (const container of metered) {
      const expected = {
        vcpu: container.instance_type.vcpu,
        memoryMiB: container.instance_type.memory_mib,
        diskMB: container.instance_type.disk_mb,
      };
      expect(SANDBOX_CAPACITIES[container.class_name]).toEqual(expected);
      expect(containerCapacityForService(SERVICE_BY_CLASS[container.class_name])).toEqual({
        vcpu: expected.vcpu,
        memoryBytes: expected.memoryMiB * 1024 ** 2,
        diskBytes: expected.diskMB * 1_000_000,
      });
    }
  });

  it('matches containers billing capacities to the selectable instances and web labels', () => {
    const resolved = CLOUDFLARE_CONTAINERS_INSTANCES.map(instance => ({
      instance,
      identity: containersBillingIdentity(instance),
    }));
    expect(new Set(resolved.map(entry => entry.identity.className))).toEqual(
      new Set(Object.keys(CONTAINERS_BILLING_CAPACITIES))
    );

    const webSource = fs.readFileSync(
      fileURLToPath(
        new URL(
          '../../../apps/web/src/components/cloud-agent-next/sandbox-selection.ts',
          import.meta.url
        ).href
      ),
      'utf8'
    );
    for (const { instance, identity } of resolved) {
      const { capacity } = identity;
      expect(webSource).toContain(
        `'${instance}': '${usageServiceForSandboxClass(identity.className)}',`
      );
      expect(containerCapacityForService(usageServiceForSandboxClass(identity.className))).toEqual({
        vcpu: capacity.vcpu,
        memoryBytes: capacity.memoryMiB * 1024 ** 2,
        diskBytes: capacity.diskMB * 1_000_000,
      });
    }

    // Web labels name the memory ladder tier; disk follows the Cloudflare instance-type table.
    expect(CONTAINERS_BILLING_CAPACITIES.SandboxContainersStandard3.diskMB).toBe(16_000);
    expect(CONTAINERS_BILLING_CAPACITIES.SandboxContainersStandard4.diskMB).toBe(20_000);
  });
});
