import { describe, expect, it } from 'vitest';

import { resolveMobileMessageInputAvailability } from './bot-send-state';

const NOW = 1_000_000;

describe('mobile bot send gate', () => {
  it('blocks sends while bot status is unknown', () => {
    const state = resolveMobileMessageInputAvailability({
      currentUserId: 'user-1',
      instanceStatus: 'running',
      presence: undefined,
      now: NOW,
      pendingMutation: false,
      editing: false,
    });

    expect(state.disabled).toBe(true);
    expect(state.disabledReason).toBe('Waiting for bot status...');
  });

  it('blocks sends when the bot is offline or stale', () => {
    expect(
      resolveMobileMessageInputAvailability({
        currentUserId: 'user-1',
        instanceStatus: 'running',
        presence: { online: false, lastAt: NOW },
        now: NOW,
        pendingMutation: false,
        editing: false,
      }).disabled
    ).toBe(true);

    expect(
      resolveMobileMessageInputAvailability({
        currentUserId: 'user-1',
        instanceStatus: 'running',
        presence: { online: true, lastAt: NOW - 91_000 },
        now: NOW,
        pendingMutation: false,
        editing: false,
      }).disabled
    ).toBe(true);
  });

  it('allows sends when the bot is online or recently idle', () => {
    expect(
      resolveMobileMessageInputAvailability({
        currentUserId: 'user-1',
        instanceStatus: 'running',
        presence: { online: true, lastAt: NOW - 10_000 },
        now: NOW,
        pendingMutation: false,
        editing: false,
      }).disabled
    ).toBe(false);

    expect(
      resolveMobileMessageInputAvailability({
        currentUserId: 'user-1',
        instanceStatus: 'running',
        presence: { online: true, lastAt: NOW - 45_000 },
        now: NOW,
        pendingMutation: false,
        editing: false,
      }).disabled
    ).toBe(false);
  });

  it('allows fresh bot presence while instance status is unknown', () => {
    const state = resolveMobileMessageInputAvailability({
      currentUserId: 'user-1',
      instanceStatus: null,
      presence: { online: true, lastAt: NOW - 10_000 },
      now: NOW,
      pendingMutation: false,
      editing: false,
    });

    expect(state.botDisplay.state).toBe('online');
    expect(state.disabled).toBe(false);
  });

  it('blocks sends when instance status is known non-running', () => {
    const state = resolveMobileMessageInputAvailability({
      currentUserId: 'user-1',
      instanceStatus: 'stopped',
      presence: { online: true, lastAt: NOW - 10_000 },
      now: NOW,
      pendingMutation: false,
      editing: false,
    });

    expect(state.botDisplay.state).toBe('offline');
    expect(state.disabled).toBe(true);
  });

  it('keeps the composer enabled during pending sends when the bot can receive messages', () => {
    const state = resolveMobileMessageInputAvailability({
      currentUserId: 'user-1',
      instanceStatus: 'running',
      presence: { online: true, lastAt: NOW - 10_000 },
      now: NOW,
      pendingMutation: true,
      editing: false,
    });

    expect(state.disabled).toBe(false);
    expect(state.disabledReason).toBeNull();
    expect(state.submitDisabled).toBe(true);
  });
});
