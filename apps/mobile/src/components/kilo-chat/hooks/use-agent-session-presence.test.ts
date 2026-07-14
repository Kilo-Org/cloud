import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentSessionPresence } from './use-agent-session-presence';

const testState = vi.hoisted(() => ({
  context: null as string | null,
  active: false,
  appActiveAndFocused: true,
}));

vi.mock('@kilocode/kilo-chat-hooks', () => ({
  usePresenceSubscription: (context: string | null, active: boolean) => {
    testState.context = context;
    testState.active = active;
  },
}));

vi.mock('./use-app-active-and-focused', () => ({
  useAppActiveAndFocused: () => testState.appActiveAndFocused,
}));

describe('useAgentSessionPresence', () => {
  beforeEach(() => {
    testState.context = null;
    testState.active = false;
    testState.appActiveAndFocused = true;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes to the exact agent-session context when active and focused', () => {
    useAgentSessionPresence('session-123');
    expect(testState.context).toBe('/presence/agent-session/session-123');
    expect(testState.active).toBe(true);
  });

  it('passes null context and disabled flag when no session id is provided', () => {
    useAgentSessionPresence(undefined);
    expect(testState.context).toBeNull();
    expect(testState.active).toBe(false);
  });

  it('disables the subscription when the app is not active and focused', () => {
    testState.appActiveAndFocused = false;
    useAgentSessionPresence('session-123');
    expect(testState.context).toBe('/presence/agent-session/session-123');
    expect(testState.active).toBe(false);
  });
});
