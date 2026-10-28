import { describe, expect, it } from 'vitest';
import { allowsSubagentSessions, isTrustedWorktreeCreateOrigin } from './session-registration.js';

describe('isTrustedWorktreeCreateOrigin', () => {
  it('allows the authenticated browser workspace-create pair', () => {
    expect(isTrustedWorktreeCreateOrigin('browser', 'cloud-agent-web')).toBe(true);
  });

  it('allows the authenticated Agent Manager workspace-create pair', () => {
    expect(isTrustedWorktreeCreateOrigin('agent-manager', 'agent-manager')).toBe(true);
  });

  it.each([
    ['browser', 'agent-manager'],
    ['agent-manager', 'cloud-agent-web'],
    ['browser', 'cloud-agent'],
    ['mobile', 'cloud-agent-web'],
    [undefined, 'agent-manager'],
    ['agent-manager', undefined],
  ])('rejects an untrusted provenance/origin pair (%s, %s)', (provenance, origin) => {
    expect(isTrustedWorktreeCreateOrigin(provenance, origin)).toBe(false);
  });
});

describe('allowsSubagentSessions', () => {
  it.each(['cloud-agent-web', 'desktop', 'agent-manager'])(
    'grants spawn permission to the interactive %s origin',
    createdOnPlatform => {
      expect(allowsSubagentSessions({ options: { createdOnPlatform } })).toBe(true);
    }
  );

  it.each(['cloud-agent', 'slack', 'github', 'code-review', 'security-agent', undefined])(
    'denies spawn permission to the non-interactive %s origin',
    createdOnPlatform => {
      expect(allowsSubagentSessions({ options: { createdOnPlatform } })).toBe(false);
    }
  );

  it('denies spawned child sessions their own spawn permission', () => {
    expect(
      allowsSubagentSessions({
        options: { createdOnPlatform: 'cloud-agent-web' },
        parentCloudAgentSessionId: 'workspace_parent',
      })
    ).toBe(false);
  });

  it('denies spawn permission on a shared sandbox', () => {
    expect(
      allowsSubagentSessions({
        options: { createdOnPlatform: 'cloud-agent-web' },
        runtime: { sandboxAllocation: 'cloudflare-shared' },
      })
    ).toBe(false);
    expect(
      allowsSubagentSessions({
        options: { createdOnPlatform: 'cloud-agent-web' },
        savedSandboxAllocation: 'cloudflare-shared',
      })
    ).toBe(false);
  });

  it('allows spawn permission on an isolated allocation', () => {
    expect(
      allowsSubagentSessions({
        options: { createdOnPlatform: 'cloud-agent-web' },
        runtime: { sandboxAllocation: 'cloudflare-containers-standard-3' },
      })
    ).toBe(true);
  });
});
