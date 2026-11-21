import { describe, expect, test } from '@jest/globals';
import { createSignedToken } from '@/lib/signed-token';
import {
  createSlackBotLinkState,
  isSlackBotLinkState,
  verifySlackBotLinkState,
} from './slack-link-state';

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

describe('isSlackBotLinkState', () => {
  test('classifies an expired state that verification rejects', () => {
    const realNow = Date.now;
    let state: string;
    try {
      Date.now = () => 1_000_000_000_000;
      state = createSlackBotLinkState(params);
      Date.now = () => 1_000_000_000_000 + 11 * 60 * 1000;

      expect(verifySlackBotLinkState(state)).toBeNull();
      expect(isSlackBotLinkState(state)).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  test('classifies a correctly signed bot-link state', () => {
    expect(isSlackBotLinkState(createSlackBotLinkState(params))).toBe(true);
  });

  test('classifies a tampered-signature state', () => {
    const [payload, signature] = createSlackBotLinkState(params).split('.');

    expect(isSlackBotLinkState(`${payload}.${signature}x`)).toBe(true);
  });

  test('does not classify an install-flow state', () => {
    const installState = createSignedToken({
      provider: 'slack',
      purpose: 'provider_install',
      owner: 'user:x',
      userId: 'y',
    });

    expect(isSlackBotLinkState(installState)).toBe(false);
  });

  test('does not classify missing or undecodable input', () => {
    expect(isSlackBotLinkState(null)).toBe(false);
    expect(isSlackBotLinkState('')).toBe(false);
    expect(isSlackBotLinkState('garbage')).toBe(false);
    expect(isSlackBotLinkState('bm90anNvbg.')).toBe(false);
  });
});
