import { describe, expect, it } from 'vitest';
import { PROVIDER_CAPABILITIES, sessionHasTerminal } from './capabilities.js';

describe('E2B capabilities', () => {
  it('supports the control-plane terminal without a legacy terminal or devcontainer', () => {
    expect(sessionHasTerminal('workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'e2b')).toBe(true);
    expect(sessionHasTerminal('agent_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'e2b')).toBe(false);
    expect(PROVIDER_CAPABILITIES.e2b.devcontainer).toBe(false);
  });

  it.each(['cloudflare', 'vercel', 'onprem'] as const)(
    'preserves %s terminal behavior',
    provider => {
      expect(sessionHasTerminal('workspace_existing', provider)).toBe(true);
      expect(sessionHasTerminal('agent_existing', provider)).toBe(provider === 'cloudflare');
    }
  );
});
