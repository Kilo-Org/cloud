import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every JavaScript instance claims its own React view-tag range, because Android keeps state
 * keyed by those tags for the life of the process and a reloaded instance would otherwise
 * reissue the tags the previous instance's views still hold.
 */
const host = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
  claimRange: vi.fn(),
}));

vi.mock('expo', () => ({ requireOptionalNativeModule: host.requireOptionalNativeModule }));

// The module reads the native range provider once, when it is first evaluated, so each case
// needs a fresh evaluation: a static import would pin the first case's module.
async function loadClaim(): Promise<() => number> {
  vi.resetModules();
  const module = await import('./view-tag-range');
  return module.claimViewTagRange;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  host.requireOptionalNativeModule.mockReturnValue({ claimRange: host.claimRange });
  host.claimRange.mockReturnValue(2_097_152);
  delete globalThis.__kiloViewTagBase;
});

describe('claimViewTagRange', () => {
  it('publishes the claimed range for the renderer to read', async () => {
    const claimViewTagRange = await loadClaim();

    expect(claimViewTagRange()).toBe(2_097_152);
    expect(host.requireOptionalNativeModule).toHaveBeenCalledWith('KiloViewTagRange');
    expect(globalThis.__kiloViewTagBase).toBe(2_097_152);
  });

  it('claims a fresh range for every instance', async () => {
    host.claimRange.mockReturnValueOnce(2_097_152).mockReturnValueOnce(4_194_304);
    const claimViewTagRange = await loadClaim();

    expect(claimViewTagRange()).toBe(2_097_152);
    expect(claimViewTagRange()).toBe(4_194_304);
    expect(host.claimRange).toHaveBeenCalledTimes(2);
  });

  it('starts at the platform range in a build without the module', async () => {
    host.requireOptionalNativeModule.mockReturnValue(null);
    const claimViewTagRange = await loadClaim();

    expect(claimViewTagRange()).toBe(0);
    expect(globalThis.__kiloViewTagBase).toBe(0);
  });

  it('ignores a range it cannot use instead of handing the renderer a broken start', async () => {
    const claimViewTagRange = await loadClaim();

    for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      host.claimRange.mockReturnValueOnce(value);
      expect(claimViewTagRange()).toBe(0);
      expect(globalThis.__kiloViewTagBase).toBe(0);
    }
  });
});
