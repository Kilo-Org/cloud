import { describe, expect, it } from 'vitest';

import { resolveIncomingUrl } from '@kilocode/app-shared/universal-links';

import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';
import {
  deriveLauncherTargets,
  LAUNCHER_NEW_AGENT_URL,
  LAUNCHER_SESSION_URL_PREFIX,
  launcherSessionUrl,
  waitedSinceFor,
} from '@/lib/launcher-surfaces';

function waiting(id: string, waitedSince: number) {
  return { id, waitedSince };
}

describe('launcher target deep links', () => {
  // The invariant the launcher surfaces exist for: these URLs are not a
  // second routing table, they resolve to the routes the in-app controls push.
  it('the New agent target resolves to the route the FAB pushes', () => {
    expect(resolveIncomingUrl(LAUNCHER_NEW_AGENT_URL)).toBe(getNewAgentSessionPath(null));
    expect(resolveIncomingUrl(LAUNCHER_NEW_AGENT_URL)).toBe('/(app)/agent-chat/new');
  });

  it('a session target resolves to that session route', () => {
    expect(resolveIncomingUrl(launcherSessionUrl('ses_1'))).toBe('/(app)/agent-chat/ses_1');
  });

  it('the session URL prefix alone resolves to the Agents tab', () => {
    expect(resolveIncomingUrl(LAUNCHER_SESSION_URL_PREFIX)).toBe('/(app)/(tabs)/(2_agents)');
  });

  it('an id needing encoding stays one segment and lands on the same route', () => {
    const id = 'ses_1/2 3';
    const url = launcherSessionUrl(id);
    expect(url).toBe('kiloapp:///cloud/sessions/ses_1%2F2%203');
    expect(resolveIncomingUrl(url)).toBe('/(app)/agent-chat/ses_1%2F2%203');

    // Unencoded, `id` splits across path segments and `/cloud/sessions/*`
    // no longer matches: encoding is what keeps the link on the route.
    expect(resolveIncomingUrl(`kiloapp:///cloud/sessions/${id}`)).toBeNull();
  });

  it('an id holding a query delimiter is not truncated to another session', () => {
    const id = 'ses_1?tab=2';
    const url = launcherSessionUrl(id);
    expect(url).toBe('kiloapp:///cloud/sessions/ses_1%3Ftab%3D2');
    expect(resolveIncomingUrl(url)).toBe('/(app)/agent-chat/ses_1%3Ftab%3D2');

    // The resolver drops query and fragment before matching, so an unencoded
    // `?` silently truncates the id and opens a *different* session.
    expect(resolveIncomingUrl(`kiloapp:///cloud/sessions/${id}`)).toBe('/(app)/agent-chat/ses_1');
  });
});

describe('deriveLauncherTargets', () => {
  it('always exposes New agent, even with nothing to open', () => {
    expect(deriveLauncherTargets({ waiting: [], lastOpenedSessionId: null })).toEqual({
      newAgentUrl: LAUNCHER_NEW_AGENT_URL,
      needsInputUrl: null,
      openLastSessionUrl: null,
    });
  });

  it('leaves Needs input absent when nothing waits', () => {
    const targets = deriveLauncherTargets({ waiting: [], lastOpenedSessionId: 'ses_1' });
    expect(targets.needsInputUrl).toBeNull();
  });

  it('picks the longest wait, not the first row', () => {
    const targets = deriveLauncherTargets({
      waiting: [waiting('ses_recent', 5000), waiting('ses_oldest', 1000), waiting('ses_mid', 3000)],
      lastOpenedSessionId: null,
    });
    const url = targets.needsInputUrl;
    expect(url).toBe(launcherSessionUrl('ses_oldest'));
    expect(url === null ? null : resolveIncomingUrl(url)).toBe('/(app)/agent-chat/ses_oldest');
  });

  it('keeps input order on equal waits', () => {
    const targets = deriveLauncherTargets({
      waiting: [waiting('ses_first', 1000), waiting('ses_second', 1000)],
      lastOpenedSessionId: null,
    });
    expect(targets.needsInputUrl).toBe(launcherSessionUrl('ses_first'));
  });

  it('opens the last session, absent for a null or empty id', () => {
    const lastSessionUrl = deriveLauncherTargets({
      waiting: [],
      lastOpenedSessionId: 'ses_1',
    }).openLastSessionUrl;
    expect(lastSessionUrl).toBe(launcherSessionUrl('ses_1'));
    expect(lastSessionUrl === null ? null : resolveIncomingUrl(lastSessionUrl)).toBe(
      '/(app)/agent-chat/ses_1'
    );
    expect(
      deriveLauncherTargets({ waiting: [], lastOpenedSessionId: null }).openLastSessionUrl
    ).toBeNull();
    expect(
      deriveLauncherTargets({ waiting: [], lastOpenedSessionId: '' }).openLastSessionUrl
    ).toBeNull();
  });

  it('does not mutate its input', () => {
    const input = [waiting('ses_b', 2000), waiting('ses_a', 1000)];
    const snapshot = [...input];
    deriveLauncherTargets({ waiting: input, lastOpenedSessionId: 'ses_1' });
    expect(input).toEqual(snapshot);
    expect(input[0]).toBe(snapshot[0]);
    expect(input[1]).toBe(snapshot[1]);
  });
});

describe('waitedSinceFor', () => {
  it('keeps a real raise timestamp as the sort key', () => {
    expect(waitedSinceFor('2026-08-24T10:00:00Z')).toBe(Date.parse('2026-08-24T10:00:00Z'));
  });

  it('reports an unknown wait as the largest key, never the smallest', () => {
    expect(waitedSinceFor(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(waitedSinceFor(null)).toBe(Number.POSITIVE_INFINITY);
    expect(waitedSinceFor('not a timestamp')).toBe(Number.POSITIVE_INFINITY);
  });

  it('does not let a timestamp-less row outrank a real wait', () => {
    // The regression: with a 0 fallback the timestamp-less row held the smallest
    // key, so `longestWaiting` picked it over a session with a real wait.
    const targets = deriveLauncherTargets({
      waiting: [waiting('ses_unknown', waitedSinceFor(null)), waiting('ses_oldest', 1000)],
      lastOpenedSessionId: null,
    });

    expect(targets.needsInputUrl).toBe(launcherSessionUrl('ses_oldest'));
  });

  it('keeps input order when no row has a raise timestamp', () => {
    const targets = deriveLauncherTargets({
      waiting: [
        waiting('ses_first', waitedSinceFor(undefined)),
        waiting('ses_second', waitedSinceFor(undefined)),
      ],
      lastOpenedSessionId: null,
    });

    expect(targets.needsInputUrl).toBe(launcherSessionUrl('ses_first'));
  });
});
