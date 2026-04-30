import { buildKiloChatRedirect } from './chat-redirect';

describe('buildKiloChatRedirect', () => {
  it('preserves organization kilo-chat base paths', () => {
    expect(buildKiloChatRedirect('/organizations/org-1/claw/kilo-chat', 'sandbox/with space')).toBe(
      '/organizations/org-1/claw/kilo-chat?sandboxId=sandbox%2Fwith%20space'
    );
  });
});
