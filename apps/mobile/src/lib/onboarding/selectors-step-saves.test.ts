import { describe, expect, it } from 'vitest';

import { type BotIdentity } from './index';
import { INITIAL_STATE, type OnboardingEvent, reduce } from './machine';
import { shouldSaveBotIdentity, shouldSaveExecPreset } from './selectors';

const IDENTITY: BotIdentity = {
  botName: 'KiloClaw',
  botNature: 'AI assistant',
  botVibe: 'Helpful',
  botEmoji: '🤖',
};

function run(events: OnboardingEvent[]) {
  let state = INITIAL_STATE;
  for (const event of events) {
    state = reduce(state, event);
  }
  return state;
}

describe('shouldSaveBotIdentity', () => {
  it('is false before provision succeeds', () => {
    const s = reduce(INITIAL_STATE, { type: 'identity-submitted', identity: IDENTITY });
    expect(shouldSaveBotIdentity(s)).toBe(false);
  });

  it('is false before the user has committed identity', () => {
    const s = reduce(INITIAL_STATE, { type: 'provision-succeeded', sandboxId: 'sb-1' });
    expect(shouldSaveBotIdentity(s)).toBe(false);
  });

  it('is true once both provision and identity have landed', () => {
    const s = run([
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'identity-submitted', identity: IDENTITY },
    ]);
    expect(shouldSaveBotIdentity(s)).toBe(true);
  });

  it('is also true when identity lands first and provision arrives afterwards', () => {
    const s = run([
      { type: 'identity-submitted', identity: IDENTITY },
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
    ]);
    expect(shouldSaveBotIdentity(s)).toBe(true);
  });

  it('flips to false after the dispatch ack (fire-once)', () => {
    const ready = run([
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'identity-submitted', identity: IDENTITY },
    ]);
    expect(shouldSaveBotIdentity(ready)).toBe(true);
    const acked = reduce(ready, { type: 'bot-identity-saved' });
    expect(shouldSaveBotIdentity(acked)).toBe(false);
  });

  it('re-opens after retry-requested so the mutation re-fires on retry', () => {
    const s = run([
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'identity-submitted', identity: IDENTITY },
      { type: 'bot-identity-saved' },
      { type: 'retry-requested' },
      { type: 'identity-submitted', identity: IDENTITY },
    ]);
    expect(shouldSaveBotIdentity(s)).toBe(true);
  });

  it('re-opens when the user goes back and re-submits identity with a new name', () => {
    const s = run([
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'identity-submitted', identity: IDENTITY },
      { type: 'bot-identity-saved' },
      { type: 'step-back' },
      { type: 'identity-submitted', identity: { ...IDENTITY, botName: 'Renamed' } },
    ]);
    expect(shouldSaveBotIdentity(s)).toBe(true);
  });
});

describe('shouldSaveExecPreset', () => {
  it('is false before provision succeeds', () => {
    const s = reduce(INITIAL_STATE, { type: 'identity-submitted', identity: IDENTITY });
    expect(shouldSaveExecPreset(s)).toBe(false);
  });

  it('is true once provision and identity have landed (mobile defaults to never-ask)', () => {
    const s = run([
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'identity-submitted', identity: IDENTITY },
    ]);
    expect(shouldSaveExecPreset(s)).toBe(true);
  });

  it('flips to false after the dispatch ack (fire-once)', () => {
    const ready = run([
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'identity-submitted', identity: IDENTITY },
    ]);
    expect(shouldSaveExecPreset(ready)).toBe(true);
    const acked = reduce(ready, { type: 'exec-preset-saved' });
    expect(shouldSaveExecPreset(acked)).toBe(false);
  });

  it('re-opens after retry-requested', () => {
    const s = run([
      { type: 'provision-succeeded', sandboxId: 'sb-1' },
      { type: 'identity-submitted', identity: IDENTITY },
      { type: 'exec-preset-saved' },
      { type: 'retry-requested' },
      { type: 'identity-submitted', identity: IDENTITY },
    ]);
    expect(shouldSaveExecPreset(s)).toBe(true);
  });
});
