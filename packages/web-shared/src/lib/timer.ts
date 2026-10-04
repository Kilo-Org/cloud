import { logExceptInTest } from '@/lib/utils.server';

/**
 * Creates a timer that can be used to measure elapsed time
 * @returns A timer object with a log method to output elapsed time with a description
 */
export function createTimer() {
  const startTime = performance.now();
  const elapsedMS = () => performance.now() - startTime;
  return {
    elapsedMS,
    log: (description: string) =>
      logExceptInTest(`[Timer] ${description}: ${elapsedMS().toFixed(2)}ms`),
  };
}
