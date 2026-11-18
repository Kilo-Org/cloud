import type { EnvironmentBuildInput } from '@kilocode/cloud-agent-profile';
import { describe, expect, it } from 'vitest';
import { buildInputRecordOf } from './build-input.js';
import type { EnvironmentBuildTarget } from './target.js';

const input: EnvironmentBuildInput = {
  reference: {
    environmentId: '11111111-1111-4111-8111-111111111111',
    owner: { type: 'organization', id: '22222222-2222-4222-8222-222222222222' },
    configurationRevision: 1,
    repository: { platform: 'github', repoFullName: 'acme/widgets' },
  },
  repoFullName: 'acme/widgets',
  commands: ['pnpm install'],
  plainVars: {},
  encryptedSecrets: {},
  sandboxAllocation: null,
  egressMode: 'allowlist',
  egressAllowlist: ['registry.npmjs.org'],
};

describe('buildInputRecordOf', () => {
  it('keeps a Containers build in the shape the previous release reads', () => {
    const target: EnvironmentBuildTarget = {
      provider: 'cloudflare-containers',
      instance: 'standard-4',
    };
    // The previous release's strict record has exactly these keys.
    expect(Object.keys(buildInputRecordOf(input, target)).sort()).toEqual(
      ['commands', 'plainVars', 'reference', 'repoFullName', 'target'].sort()
    );
  });

  it('pins the egress policy for an AWS build, which enforces it in the customer VPC', () => {
    const target = { provider: 'aws-ecs' } as EnvironmentBuildTarget;
    expect(buildInputRecordOf(input, target).egressPolicy).toEqual({
      egressMode: 'allowlist',
      egressAllowlist: ['registry.npmjs.org'],
    });
  });
});
