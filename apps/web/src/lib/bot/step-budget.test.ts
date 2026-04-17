import { MAX_ITERATIONS } from '@/lib/bot/constants';
import {
  getNextBotCallbackStep,
  getRemainingBotIterations,
  parseBotCallbackStep,
} from '@/lib/bot/step-budget';

describe('bot step budget', () => {
  it('parses currentStep callback values safely', () => {
    expect(parseBotCallbackStep(null)).toBe(0);
    expect(parseBotCallbackStep('bad')).toBe(0);
    expect(parseBotCallbackStep('-1')).toBe(0);
    expect(parseBotCallbackStep('2.5')).toBe(0);
    expect(parseBotCallbackStep('3')).toBe(3);
    expect(parseBotCallbackStep(String(MAX_ITERATIONS + 10))).toBe(MAX_ITERATIONS);
  });

  it('computes remaining iterations from completed steps', () => {
    expect(getRemainingBotIterations(0)).toBe(MAX_ITERATIONS);
    expect(getRemainingBotIterations(2)).toBe(MAX_ITERATIONS - 2);
    expect(getRemainingBotIterations(MAX_ITERATIONS)).toBe(0);
    expect(getRemainingBotIterations(MAX_ITERATIONS + 1)).toBe(0);
  });

  it('counts the in-flight spawn step for the next callback URL', () => {
    expect(getNextBotCallbackStep({ completedStepCount: 1, completedStepsInCurrentRun: 0 })).toBe(
      2
    );
    expect(getNextBotCallbackStep({ completedStepCount: 1, completedStepsInCurrentRun: 2 })).toBe(
      4
    );
    expect(
      getNextBotCallbackStep({
        completedStepCount: MAX_ITERATIONS,
        completedStepsInCurrentRun: 1,
      })
    ).toBe(MAX_ITERATIONS);
  });
});
