import { describe, expect, it } from 'vitest';

import { isPrivacyCoverRoute } from './privacy-cover';

describe('isPrivacyCoverRoute', () => {
  it('leaves language pickers above login and preferences uncovered', () => {
    expect(isPrivacyCoverRoute(['(auth)', 'language-picker'])).toBe(false);
    expect(isPrivacyCoverRoute(['(app)', 'language-picker'])).toBe(false);
  });

  it('covers the profile tab group', () => {
    expect(isPrivacyCoverRoute(['(app)', '(tabs)', '(3_profile)'])).toBe(true);
    expect(
      isPrivacyCoverRoute(['(app)', '(tabs)', '(3_profile)', 'security-agent', '[scope]'])
    ).toBe(true);
  });

  it('leaves every other surface uncovered', () => {
    expect(isPrivacyCoverRoute([])).toBe(false);
    expect(isPrivacyCoverRoute(['(app)'])).toBe(false);
    expect(isPrivacyCoverRoute(['(app)', '(tabs)', '(0_home)'])).toBe(false);
    expect(isPrivacyCoverRoute(['(app)', '(tabs)', '(1_kiloclaw)'])).toBe(false);
    expect(isPrivacyCoverRoute(['(app)', '(tabs)', '(2_agents)'])).toBe(false);
    expect(isPrivacyCoverRoute(['(auth)', 'login'])).toBe(false);
    expect(isPrivacyCoverRoute(['agent-chat', '[session-id]'])).toBe(false);
    expect(isPrivacyCoverRoute(['pr-review', '[owner]', '[repo]', '[number]'])).toBe(false);
    expect(isPrivacyCoverRoute(['kilo-pass'])).toBe(false);
    expect(isPrivacyCoverRoute(['device-sessions'])).toBe(false);
    expect(isPrivacyCoverRoute(['share-gate'])).toBe(false);
  });

  it('matches tokens, not slash-prefixed paths', () => {
    expect(isPrivacyCoverRoute(['/(3_profile)'])).toBe(false);
  });
});
