import fs from 'node:fs';
import path from 'node:path';

import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

import { containerCapacityForService } from '../../../apps/web/src/lib/cloudflare/container-capacity.js';
import { SANDBOX_CAPACITIES, type SandboxClassName } from './container-usage-context.js';

type WranglerContainer = {
  class_name: SandboxClassName;
  instance_type: {
    vcpu: number;
    memory_mib: number;
    disk_mb: number;
  };
};

type WranglerConfig = {
  containers: WranglerContainer[];
};

const SERVICE_BY_CLASS: Record<SandboxClassName, string> = {
  Sandbox: 'cloud-agent-next-sandbox',
  SandboxContainment: 'cloud-agent-next-sandbox-containment',
  SandboxSmall: 'cloud-agent-next-sandbox-small',
  SandboxSmallContainment: 'cloud-agent-next-sandbox-small-containment',
  SandboxDIND: 'cloud-agent-next-sandbox-dind',
  SandboxCodeReview: 'cloud-agent-next-sandbox-code-review',
  SandboxCodeReviewContainment: 'cloud-agent-next-sandbox-code-review-containment',
};

describe('production container capacity parity', () => {
  it('keeps Wrangler, usage metadata, and web reconciliation capacities aligned', () => {
    const config = parse(
      fs.readFileSync(path.join(process.cwd(), 'wrangler.jsonc'), 'utf8')
    ) as WranglerConfig;

    expect(config.containers).toHaveLength(Object.keys(SANDBOX_CAPACITIES).length);
    for (const container of config.containers) {
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
});
