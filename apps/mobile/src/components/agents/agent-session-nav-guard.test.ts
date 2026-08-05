import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_SESSION_NAV_GUARD_MS,
  type AgentSessionNavGuardState,
  pushAgentSessionOnce,
} from './agent-session-nav-guard';

const SESSION_ID = 'ses_12345678901234567890123456';
const ORG_ID = 'org_abc123';
const T0 = 1_700_000_000_000;

function setup() {
  const push = vi.fn();
  const state: AgentSessionNavGuardState = { lastPushAt: 0 };
  return { push, router: { push }, state };
}

describe('pushAgentSessionOnce', () => {
  it('pushes once on first call and returns true', () => {
    const { router, state } = setup();
    const result = pushAgentSessionOnce({
      state,
      router,
      now: T0,
      sessionId: SESSION_ID,
    });
    expect(result).toBe(true);
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(router.push).toHaveBeenCalledWith(`/(app)/agent-chat/${SESSION_ID}`);
  });

  it('drops a second fast tap on the same session', () => {
    const { router, state } = setup();
    pushAgentSessionOnce({ state, router, now: T0, sessionId: SESSION_ID });
    const result = pushAgentSessionOnce({
      state,
      router,
      now: T0 + 50,
      sessionId: SESSION_ID,
    });
    expect(result).toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('drops a second fast tap on a different session', () => {
    const { router, state } = setup();
    pushAgentSessionOnce({ state, router, now: T0, sessionId: SESSION_ID });
    const result = pushAgentSessionOnce({
      state,
      router,
      now: T0 + 50,
      sessionId: 'ses_other',
    });
    expect(result).toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the guard window expires', () => {
    const { router, state } = setup();
    pushAgentSessionOnce({ state, router, now: T0, sessionId: SESSION_ID });
    const result = pushAgentSessionOnce({
      state,
      router,
      now: T0 + AGENT_SESSION_NAV_GUARD_MS,
      sessionId: SESSION_ID,
    });
    expect(result).toBe(true);
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it('re-arms on reset (focus simulation)', () => {
    const { router, state } = setup();
    pushAgentSessionOnce({ state, router, now: T0, sessionId: SESSION_ID });
    // Blocked call
    pushAgentSessionOnce({ state, router, now: T0 + 50, sessionId: SESSION_ID });
    // Reset the guard as focus would
    state.lastPushAt = 0;
    const result = pushAgentSessionOnce({
      state,
      router,
      now: T0 + 50,
      sessionId: SESSION_ID,
    });
    expect(result).toBe(true);
    expect(router.push).toHaveBeenCalledTimes(2);
  });

  it('includes organizationId in the path when provided', () => {
    const { router, state } = setup();
    pushAgentSessionOnce({
      state,
      router,
      now: T0,
      sessionId: SESSION_ID,
      organizationId: ORG_ID,
    });
    expect(router.push).toHaveBeenCalledWith(
      `/(app)/agent-chat/${SESSION_ID}?organizationId=${ORG_ID}`
    );
  });

  it('pushes the plain path when organizationId is null', () => {
    const { router, state } = setup();
    pushAgentSessionOnce({
      state,
      router,
      now: T0,
      sessionId: SESSION_ID,
      organizationId: null,
    });
    expect(router.push).toHaveBeenCalledWith(`/(app)/agent-chat/${SESSION_ID}`);
  });
});
