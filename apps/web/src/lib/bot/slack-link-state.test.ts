import { describe, expect, test } from '@jest/globals';
import { createSignedToken } from '@/lib/signed-token';
import { createSlackBotLinkState, verifySlackBotLinkState } from './slack-link-state';

const params = {
  userId: 'kilo-user-1',
  slackTeamId: 'T123',
  slackUserId: 'U123',
  contextKey: 'link-account-context:abc',
};

describe('slack bot-link state', () => {
  test('round trips a payload', () => {
    const state = createSlackBotLinkState(params);

    expect(verifySlackBotLinkState(state)).toEqual(params);
  });

  test('returns null for a tampered signature', () => {
    const state = createSlackBotLinkState(params);
    const [payload, signature] = state.split('.');

    expect(verifySlackBotLinkState(`${payload}.${signature}x`)).toBeNull();
  });

  test('returns null for an expired state', () => {
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000_000_000;
      const state = createSlackBotLinkState(params);
      Date.now = () => 1_000_000_000_000 + 11 * 60 * 1000;

      expect(verifySlackBotLinkState(state)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test('rejects a signed payload without the bot-link discriminator', () => {
    const installState = createSignedToken({
      provider: 'slack',
      purpose: 'provider_install',
      owner: 'user:someone',
      userId: 'kilo-user-1',
    });

    expect(verifySlackBotLinkState(installState)).toBeNull();
  });

  test('rejects a signed payload with a different kind', () => {
    const state = createSignedToken({
      kind: 'linear-bot-link',
      userId: params.userId,
      slackTeamId: params.slackTeamId,
      slackUserId: params.slackUserId,
      contextKey: params.contextKey,
    });

    expect(verifySlackBotLinkState(state)).toBeNull();
  });

  test('rejects a payload missing the Slack identity', () => {
    const state = createSignedToken({
      kind: 'slack-bot-link',
      userId: params.userId,
      contextKey: params.contextKey,
    });

    expect(verifySlackBotLinkState(state)).toBeNull();
  });
});
