import { describe, expect, it } from 'vitest';
import { isInteractiveSessionOrigin } from './control-plane-permission.js';

describe('isInteractiveSessionOrigin', () => {
  it('treats the web and desktop clients as interactive', () => {
    expect(isInteractiveSessionOrigin('cloud-agent-web')).toBe(true);
    // A hosted IDE session has a person who can answer a question or approve a
    // CLI-enforced human permission, so the runtime must wait for them.
    expect(isInteractiveSessionOrigin('desktop')).toBe(true);
  });

  it('keeps unattended origins non-interactive', () => {
    for (const origin of ['code-review', 'security-remediation', 'slack', 'api', undefined]) {
      expect(isInteractiveSessionOrigin(origin)).toBe(false);
    }
  });
});
