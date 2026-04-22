import { describe, expect, test } from '@jest/globals';

import type { BotIdentity } from '../components/claw.types';
import {
  areOnboardingSavesReady,
  planOnboardingSaves,
  type OnboardingSaveFlags,
  type OnboardingSaveStatuses,
} from './useOnboardingSaves';

const IDENTITY: BotIdentity = {
  botName: 'Pinchy',
  botNature: 'crab assistant',
  botVibe: 'playful and sharp',
  botEmoji: '🦀',
};

function freshCompleted(): OnboardingSaveFlags {
  return { botIdentity: false, execPreset: false, channels: false };
}

function freshStatuses(overrides: Partial<OnboardingSaveStatuses> = {}): OnboardingSaveStatuses {
  return { botIdentity: 'idle', execPreset: 'idle', channels: 'idle', ...overrides };
}

describe('planOnboardingSaves', () => {
  test('saves nothing when the instance row does not exist yet', () => {
    const plan = planOnboardingSaves({
      hasInstance: false,
      botIdentity: IDENTITY,
      selectedPreset: 'never-ask',
      channelTokens: { telegramBotToken: 'abc' },
      completed: freshCompleted(),
    });

    expect(plan).toEqual({});
  });

  test('saves bot identity as soon as the instance exists and identity is present', () => {
    const plan = planOnboardingSaves({
      hasInstance: true,
      botIdentity: IDENTITY,
      selectedPreset: null,
      channelTokens: null,
      completed: freshCompleted(),
    });

    expect(plan.botIdentity).toEqual(IDENTITY);
    expect(plan.execPreset).toBeUndefined();
    expect(plan.channels).toBeUndefined();
  });

  test('saves exec preset only when the user chose never-ask', () => {
    const plan = planOnboardingSaves({
      hasInstance: true,
      botIdentity: null,
      selectedPreset: 'never-ask',
      channelTokens: null,
      completed: freshCompleted(),
    });

    expect(plan.execPreset).toEqual({ security: 'full', ask: 'off' });
  });

  test('skips exec preset when the user chose always-ask (gateway default)', () => {
    const plan = planOnboardingSaves({
      hasInstance: true,
      botIdentity: null,
      selectedPreset: 'always-ask',
      channelTokens: null,
      completed: freshCompleted(),
    });

    expect(plan.execPreset).toBeUndefined();
  });

  test('saves channels when tokens are present', () => {
    const plan = planOnboardingSaves({
      hasInstance: true,
      botIdentity: null,
      selectedPreset: null,
      channelTokens: { telegramBotToken: 'abc' },
      completed: freshCompleted(),
    });

    expect(plan.channels).toEqual({ telegramBotToken: 'abc' });
  });

  test('skips channels when the user did not enter any tokens', () => {
    const plan = planOnboardingSaves({
      hasInstance: true,
      botIdentity: null,
      selectedPreset: null,
      channelTokens: {},
      completed: freshCompleted(),
    });

    expect(plan.channels).toBeUndefined();
  });

  test('starts all three saves together once everything is ready', () => {
    const plan = planOnboardingSaves({
      hasInstance: true,
      botIdentity: IDENTITY,
      selectedPreset: 'never-ask',
      channelTokens: { telegramBotToken: 'abc' },
      completed: freshCompleted(),
    });

    expect(plan.botIdentity).toEqual(IDENTITY);
    expect(plan.execPreset).toEqual({ security: 'full', ask: 'off' });
    expect(plan.channels).toEqual({ telegramBotToken: 'abc' });
  });

  test('does not restart a save that has already completed', () => {
    const plan = planOnboardingSaves({
      hasInstance: true,
      botIdentity: IDENTITY,
      selectedPreset: 'never-ask',
      channelTokens: { telegramBotToken: 'abc' },
      completed: { botIdentity: true, execPreset: true, channels: true },
    });

    expect(plan).toEqual({});
  });

  test('does not restart a save that is already in flight', () => {
    const plan = planOnboardingSaves({
      hasInstance: true,
      botIdentity: IDENTITY,
      selectedPreset: 'never-ask',
      channelTokens: { telegramBotToken: 'abc' },
      completed: freshCompleted(),
      inFlight: { botIdentity: true, execPreset: false, channels: false },
    });

    expect(plan.botIdentity).toBeUndefined();
    expect(plan.execPreset).toEqual({ security: 'full', ask: 'off' });
    expect(plan.channels).toEqual({ telegramBotToken: 'abc' });
  });

  test('starts only the incomplete saves when re-evaluated', () => {
    const plan = planOnboardingSaves({
      hasInstance: true,
      botIdentity: IDENTITY,
      selectedPreset: 'never-ask',
      channelTokens: { telegramBotToken: 'abc' },
      completed: { botIdentity: true, execPreset: false, channels: false },
    });

    expect(plan.botIdentity).toBeUndefined();
    expect(plan.execPreset).toEqual({ security: 'full', ask: 'off' });
    expect(plan.channels).toEqual({ telegramBotToken: 'abc' });
  });
});

describe('areOnboardingSavesReady', () => {
  test('is false until the instance exists', () => {
    expect(
      areOnboardingSavesReady({
        hasInstance: false,
        botIdentity: IDENTITY,
        selectedPreset: 'never-ask',
        channelTokens: { telegramBotToken: 'abc' },
        statuses: freshStatuses({
          botIdentity: 'success',
          execPreset: 'success',
          channels: 'success',
        }),
      })
    ).toBe(false);
  });

  test('requires every required save to succeed', () => {
    expect(
      areOnboardingSavesReady({
        hasInstance: true,
        botIdentity: IDENTITY,
        selectedPreset: 'never-ask',
        channelTokens: { telegramBotToken: 'abc' },
        statuses: freshStatuses({
          botIdentity: 'success',
          execPreset: 'pending',
          channels: 'success',
        }),
      })
    ).toBe(false);
  });

  test('treats skipped optional saves as ready', () => {
    expect(
      areOnboardingSavesReady({
        hasInstance: true,
        botIdentity: IDENTITY,
        selectedPreset: 'always-ask',
        channelTokens: null,
        statuses: freshStatuses({ botIdentity: 'success' }),
      })
    ).toBe(true);
  });
});
