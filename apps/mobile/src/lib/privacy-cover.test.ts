import { describe, expect, it } from 'vitest';

import { isPrivacyCoverRoute } from './privacy-cover';

describe('isPrivacyCoverRoute', () => {
  it('covers the login route', () => {
    expect(isPrivacyCoverRoute(['login'])).toBe(true);
    expect(isPrivacyCoverRoute(['(auth)', 'login'])).toBe(true);
  });

  it('covers the agent-chat route', () => {
    expect(isPrivacyCoverRoute(['agent-chat'])).toBe(true);
    expect(isPrivacyCoverRoute(['agent-chat', '[session-id]'])).toBe(true);
  });

  it('covers the pr-review route', () => {
    expect(isPrivacyCoverRoute(['pr-review'])).toBe(true);
    expect(isPrivacyCoverRoute(['pr-review', '[owner]', '[repo]', '[number]'])).toBe(true);
  });

  it('covers the kilo-pass route', () => {
    expect(isPrivacyCoverRoute(['kilo-pass'])).toBe(true);
  });

  it('covers the device-sessions route', () => {
    expect(isPrivacyCoverRoute(['device-sessions'])).toBe(true);
  });

  it('covers the profile tab group', () => {
    expect(isPrivacyCoverRoute(['(app)', '(tabs)', '(3_profile)'])).toBe(true);
    expect(
      isPrivacyCoverRoute(['(app)', '(tabs)', '(3_profile)', 'security-agent', '[scope]'])
    ).toBe(true);
  });

  it('leaves the home tab group uncovered', () => {
    expect(isPrivacyCoverRoute(['(app)', '(tabs)', '(0_home)'])).toBe(false);
  });

  it('leaves unrelated routes uncovered', () => {
    expect(isPrivacyCoverRoute([])).toBe(false);
    expect(isPrivacyCoverRoute(['(app)'])).toBe(false);
    expect(isPrivacyCoverRoute(['(app)', '(tabs)', '(2_agents)'])).toBe(false);
  });

  it('excludes kiloclaw even under a profile-like path', () => {
    expect(isPrivacyCoverRoute(['(app)', '(tabs)', '(1_kiloclaw)'])).toBe(false);
    expect(isPrivacyCoverRoute(['(app)', 'kiloclaw', '[instance-id]', 'dashboard'])).toBe(false);
    expect(isPrivacyCoverRoute(['(app)', '(tabs)', '(3_profile)', 'kiloclaw'])).toBe(false);
  });

  it('matches tokens, not slash-prefixed paths', () => {
    expect(isPrivacyCoverRoute(['/login'])).toBe(false);
    expect(isPrivacyCoverRoute(['/(3_profile)'])).toBe(false);
  });
});
