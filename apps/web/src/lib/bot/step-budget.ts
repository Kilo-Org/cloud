import { MAX_ITERATIONS } from '@/lib/bot/constants';

export function parseBotCallbackStep(value: string | null): number {
  if (!value) return 0;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;

  return Math.min(parsed, MAX_ITERATIONS);
}

export function getRemainingBotIterations(completedStepCount: number): number {
  if (!Number.isSafeInteger(completedStepCount) || completedStepCount < 0) {
    return MAX_ITERATIONS;
  }

  return Math.max(MAX_ITERATIONS - completedStepCount, 0);
}

export function getNextBotCallbackStep(params: {
  completedStepCount: number;
  completedStepsInCurrentRun: number;
}): number {
  const completedStepCount = Number.isSafeInteger(params.completedStepCount)
    ? Math.max(params.completedStepCount, 0)
    : 0;
  const completedStepsInCurrentRun = Number.isSafeInteger(params.completedStepsInCurrentRun)
    ? Math.max(params.completedStepsInCurrentRun, 0)
    : 0;

  return Math.min(completedStepCount + completedStepsInCurrentRun + 1, MAX_ITERATIONS);
}
