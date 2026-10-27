import { describe, expect, it } from 'vitest';
import { isTrustedWorktreeCreateOrigin } from './session-registration.js';

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
