import { describe, expect, it } from '@jest/globals';
import {
  getSandboxAllocationRequest,
  type SandboxSelectionCapabilities,
} from '@kilocode/worker-utils/sandbox-allocation';
import { newSessionSandboxDestination } from './new-session-sandbox';

const medium = getSandboxAllocationRequest('cloudflare-containers-standard-3');
const large = getSandboxAllocationRequest('cloudflare-containers-standard-4');
const vercel = getSandboxAllocationRequest('vercel-small');

function capabilities(
  overrides: Partial<SandboxSelectionCapabilities> = {}
): SandboxSelectionCapabilities {
  return {
    enabled: true,
    defaultDestination: medium,
    options: [{ allocation: medium }, { allocation: large }],
    ...overrides,
  };
}

describe('newSessionSandboxDestination', () => {
  it("uses the environment's own allocation when the server offers it", () => {
    expect(
      newSessionSandboxDestination(
        'cloudflare-containers-standard-4',
        capabilities({ effectiveDestination: vercel })
      )
    ).toEqual(large);
  });

  it('skips the retired small alias, as the server does', () => {
    expect(
      newSessionSandboxDestination(
        'cloudflare-single',
        capabilities({ effectiveDestination: large })
      )
    ).toEqual(large);
  });

  it('skips an environment allocation the server does not offer', () => {
    const unavailable = capabilities({
      options: [{ allocation: medium }, { allocation: large, unavailableReason: 'Not paid' }],
    });
    expect(newSessionSandboxDestination('cloudflare-containers-standard-4', unavailable)).toEqual(
      medium
    );
    expect(
      newSessionSandboxDestination(
        'cloudflare-containers-standard-4',
        capabilities({ enabled: false, options: [] })
      )
    ).toEqual(medium);
  });

  it('falls back to the saved repository allocation, then the account default', () => {
    expect(
      newSessionSandboxDestination(null, capabilities({ effectiveDestination: large }))
    ).toEqual(large);
    expect(newSessionSandboxDestination('not-an-allocation', capabilities())).toEqual(medium);
  });

  it('is unknown until the capabilities load', () => {
    expect(
      newSessionSandboxDestination('cloudflare-containers-standard-4', undefined)
    ).toBeUndefined();
  });
});
