import { describe, expect, it, vi } from 'vitest';

import { sessionPlatformIconKind } from './session-platform-icon';

// The module under test is a .tsx that imports Lucide / brand icons (RN).
// Stub those so the pure mapper can be unit-tested in the node environment.
// (`vi.mock` calls are hoisted above the import by vitest.)
vi.mock('lucide-react-native', () => ({
  Cloud: () => null,
  Code: () => null,
  Terminal: () => null,
}));
vi.mock('@/components/icons/github-icon', () => ({
  GitHubIcon: () => null,
}));
vi.mock('@/components/icons/slack-icon', () => ({
  SlackIcon: () => null,
}));

describe('sessionPlatformIconKind', () => {
  it('maps cloud-agent and cloud-agent-web to cloud', () => {
    expect(sessionPlatformIconKind('cloud-agent')).toBe('cloud');
    expect(sessionPlatformIconKind('cloud-agent-web')).toBe('cloud');
  });

  it('maps cli to terminal', () => {
    expect(sessionPlatformIconKind('cli')).toBe('terminal');
  });

  it('maps vscode and agent-manager to code', () => {
    expect(sessionPlatformIconKind('vscode')).toBe('code');
    expect(sessionPlatformIconKind('agent-manager')).toBe('code');
  });

  it('maps slack to slack', () => {
    expect(sessionPlatformIconKind('slack')).toBe('slack');
  });

  it('maps github to github', () => {
    expect(sessionPlatformIconKind('github')).toBe('github');
  });

  it('returns null for unmapped and absent platforms', () => {
    expect(sessionPlatformIconKind('unknown')).toBeNull();
    expect(sessionPlatformIconKind('other')).toBeNull();
    expect(sessionPlatformIconKind('gastown')).toBeNull();
    expect(sessionPlatformIconKind('linear')).toBeNull();
    expect(sessionPlatformIconKind('app-builder')).toBeNull();
    expect(sessionPlatformIconKind('agent-builder')).toBeNull();
    expect(sessionPlatformIconKind(null)).toBeNull();
    expect(sessionPlatformIconKind(undefined)).toBeNull();
    expect(sessionPlatformIconKind('')).toBeNull();
  });
});
