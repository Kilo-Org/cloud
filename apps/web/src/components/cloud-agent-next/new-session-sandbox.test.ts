import { describe, expect, it } from '@jest/globals';
import {
  getSandboxAllocationRequest,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import { kiloContainersInstance, newSessionSandboxDestination } from './new-session-sandbox';

const medium = getSandboxAllocationRequest('cloudflare-containers-standard-3');
const large = getSandboxAllocationRequest('cloudflare-containers-standard-4');
const vercel = getSandboxAllocationRequest('vercel-small');

function capabilities(
  overrides: Partial<SandboxSelectionCapabilities> = {}
): SandboxSelectionCapabilities {
  return { enabled: false, defaultDestination: medium, options: [], ...overrides };
}

describe('newSessionSandboxDestination', () => {
  it("uses the environment's own allocation first", () => {
    expect(
      newSessionSandboxDestination(
        'cloudflare-containers-standard-4',
        capabilities({ effectiveDestination: vercel })
      )
    ).toEqual(large);
  });

  it('maps the retired small alias to the native containers size', () => {
    expect(newSessionSandboxDestination('cloudflare-single', undefined)).toEqual(medium);
  });

  it('falls back to the saved repository allocation, then the account default', () => {
    expect(
      newSessionSandboxDestination(null, capabilities({ effectiveDestination: large }))
    ).toEqual(large);
    expect(newSessionSandboxDestination('not-an-allocation', capabilities())).toEqual(medium);
    expect(newSessionSandboxDestination(undefined, undefined)).toBeUndefined();
  });
});

describe('kiloContainersInstance', () => {
  it('returns the instance of a Kilo-hosted container only', () => {
    expect(kiloContainersInstance(large)).toBe('standard-4');
    expect(kiloContainersInstance(vercel)).toBeNull();
    expect(kiloContainersInstance(undefined)).toBeNull();
  });
});
