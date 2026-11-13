import { describe, expect, it, vi } from 'vitest';

import { clawNotificationWebPath, clawNotificationWebUrl } from './claw-notification';

vi.mock('./external-link', () => ({ openExternalUrl: vi.fn() }));

const CHAT = {
  type: 'chat.message',
  sandboxId: 'sandbox-1',
  conversationId: 'conv_1',
  messageId: 'm1',
} as const;

describe('clawNotificationWebPath', () => {
  it('opens a chat message on its conversation', () => {
    expect(clawNotificationWebPath(CHAT)).toBe('/claw/chat/conv_1');
  });

  it('encodes a conversation id so it stays one path segment', () => {
    expect(clawNotificationWebPath({ ...CHAT, conversationId: 'a/b c' })).toBe(
      '/claw/chat/a%2Fb%20c'
    );
  });

  it.each([
    { type: 'instance-lifecycle', event: 'ready', sandboxId: 'sandbox-1' },
    { type: 'scheduled-action', event: 'scheduled_restart_notice', sandboxId: 'sandbox-1' },
  ] as const)('opens $type on the instance page', data => {
    expect(clawNotificationWebPath(data)).toBe('/claw');
  });

  it('has no page for any other push kind', () => {
    expect(
      clawNotificationWebPath({ type: 'cloud_agent_session', cliSessionId: 'ses_1' })
    ).toBeNull();
    expect(clawNotificationWebPath({ type: 'agent_briefing', url: '/agent-briefing' })).toBeNull();
    expect(clawNotificationWebPath({ type: 'low_balance', organizationId: 'org-1' })).toBeNull();
  });
});

describe('clawNotificationWebUrl', () => {
  it('joins the page to the web origin the app is configured with', () => {
    expect(clawNotificationWebUrl(CHAT, 'http://localhost:3000')).toBe(
      'http://localhost:3000/claw/chat/conv_1'
    );
  });

  it('does not double the origin separator', () => {
    expect(clawNotificationWebUrl(CHAT, 'http://localhost:3000/')).toBe(
      'http://localhost:3000/claw/chat/conv_1'
    );
  });

  it('has no URL for any other push kind', () => {
    expect(
      clawNotificationWebUrl({ type: 'cloud_agent_session', cliSessionId: 'ses_1' }, 'https://x')
    ).toBeNull();
  });
});
