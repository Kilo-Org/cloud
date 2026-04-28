import { describe, expect, it } from 'vitest';
import { shouldDefaultTelegramGroupPolicyOpen } from './telegram-group-policy';

describe('shouldDefaultTelegramGroupPolicyOpen', () => {
  it('defaults token-only Telegram configs', () => {
    expect(
      shouldDefaultTelegramGroupPolicyOpen({
        botToken: 'token',
        enabled: true,
        dmPolicy: 'pairing',
      })
    ).toBe(true);
  });

  it('defaults configs with empty or wildcard allowFrom only', () => {
    expect(shouldDefaultTelegramGroupPolicyOpen({ allowFrom: [] })).toBe(true);
    expect(shouldDefaultTelegramGroupPolicyOpen({ allowFrom: ['*'] })).toBe(true);
  });

  it('does not default when an explicit group policy exists', () => {
    expect(shouldDefaultTelegramGroupPolicyOpen({ groupPolicy: 'restricted' })).toBe(false);
    expect(shouldDefaultTelegramGroupPolicyOpen({ groupPolicy: 'disabled' })).toBe(false);
    expect(shouldDefaultTelegramGroupPolicyOpen({ groupPolicy: 'open' })).toBe(false);
  });

  it('does not default when group access config exists', () => {
    expect(shouldDefaultTelegramGroupPolicyOpen({ groups: {} })).toBe(false);
    expect(
      shouldDefaultTelegramGroupPolicyOpen({ groups: { '*': { requireMention: true } } })
    ).toBe(false);
    expect(shouldDefaultTelegramGroupPolicyOpen({ groups: { '-5055658641': {} } })).toBe(false);
  });

  it('does not default when concrete sender identifiers exist', () => {
    expect(shouldDefaultTelegramGroupPolicyOpen({ groupAllowFrom: ['7676134290'] })).toBe(false);
    expect(shouldDefaultTelegramGroupPolicyOpen({ groupAllowFrom: ['*'] })).toBe(false);
    expect(shouldDefaultTelegramGroupPolicyOpen({ allowFrom: ['7676134290'] })).toBe(false);
    expect(shouldDefaultTelegramGroupPolicyOpen({ allowFrom: ['telegram:7676134290'] })).toBe(
      false
    );
    expect(shouldDefaultTelegramGroupPolicyOpen({ allowFrom: ['-5055658641'] })).toBe(false);
  });

  it('does not default advanced multi-account Telegram config', () => {
    expect(shouldDefaultTelegramGroupPolicyOpen({ accounts: { default: {} } })).toBe(false);
  });
});
