import { logExceptInTest } from '@/lib/utils.server';

export type Timer = ReturnType<typeof createTimer>;

/**
 * Creates a timer that can be used to measure elapsed time.
 * @param startTime - Optional start time in ms (from performance.now()). Defaults to now.
 * @returns A timer object with a log method to output elapsed time with a description
 */
export function createTimer(startTime = performance.now()) {
  const elapsedMS = () => performance.now() - startTime;
  return {
    elapsedMS,
    log: (description: string) =>
      logExceptInTest(`[Timer] ${description}: ${elapsedMS().toFixed(2)}ms`),
  };
}
