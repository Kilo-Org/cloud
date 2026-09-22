import { describe, expect, it, spyOn } from 'bun:test';
import { OWNED_PROCESS_OBSERVATION_TIMEOUT_MS, type OwnedProcessScope } from './owned-processes.js';
import { settleNativeCleanup } from './worktree-runtime-cleanup.js';

function stopOnlyScope(onStop: (deadlineAt: number) => boolean): OwnedProcessScope {
  return {
    stop: async (deadlineAt: number) => onStop(deadlineAt),
  } as unknown as OwnedProcessScope;
}

describe('native cleanup budget', () => {
  it('gives a short cleanup budget a positive stop window before direct observation', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    let stopDeadlineAt = 0;
    let observeDeadlineAt = 0;
    try {
      const settled = await settleNativeCleanup({
        processes: stopOnlyScope(deadlineAt => {
          stopDeadlineAt = deadlineAt;
          return false;
        }),
        processIssued: true,
        deadlineAt: 1_400,
        observeDirect: async deadlineAt => {
          observeDeadlineAt = deadlineAt;
          return true;
        },
      });

      expect(settled).toBe(true);
      expect(stopDeadlineAt).toBeGreaterThan(1_000);
      expect(stopDeadlineAt).toBeLessThanOrEqual(1_400);
      expect(observeDeadlineAt).toBe(1_400);
    } finally {
      clock.mockRestore();
    }
  });

  it('lets direct observation override a failed stop within a short budget', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    let observed = false;
    try {
      const settled = await settleNativeCleanup({
        processes: stopOnlyScope(() => false),
        processIssued: true,
        deadlineAt: 1_200,
        observeDirect: async () => {
          observed = true;
          return false;
        },
      });

      expect(observed).toBe(true);
      expect(settled).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps the full observation reserve for an ordinary cleanup budget', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    let stopDeadlineAt = 0;
    try {
      await settleNativeCleanup({
        processes: stopOnlyScope(deadlineAt => {
          stopDeadlineAt = deadlineAt;
          return false;
        }),
        processIssued: true,
        deadlineAt: 10_000,
        observeDirect: async () => false,
      });

      expect(stopDeadlineAt).toBe(10_000 - OWNED_PROCESS_OBSERVATION_TIMEOUT_MS);
    } finally {
      clock.mockRestore();
    }
  });
});
