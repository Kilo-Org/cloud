/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount the section in the node vitest environment (same pattern as the mounted tests) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSessionsSection, buildRows } from '@/components/home/agent-sessions-section';
import { type ActiveSession, type StoredSession } from '@/lib/hooks/use-agent-sessions';

const navigateSpy = vi.hoisted(() => vi.fn());
const dismissToSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: navigateSpy, dismissTo: dismissToSpy }),
  useFocusEffect: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('@/components/home/section-header', () => ({
  SectionHeader: 'SectionHeader',
}));

vi.mock('@/components/agents/remote-session-row', () => ({
  RemoteSessionRow: () => null,
}));

vi.mock('@/components/ui/text', () => ({
  Text: () => null,
}));

vi.mock('@/components/agents/session-row', () => ({
  StoredSessionRow: () => null,
}));

vi.mock('@/components/agents/use-agent-session-navigator', () => ({
  useAgentSessionNavigator: () => vi.fn(),
}));

vi.mock('@/lib/hooks/use-agent-sessions', () => ({
  useAgentSessions: () => ({
    activeSessions: [],
    storedSessions: [],
    activeSessionIds: new Set(),
    activeIsError: false,
  }),
}));

function makeActive(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: 'a1',
    status: 'running',
    title: 'test',
    connectionId: 'c1',
    ...over,
  };
}

function makeStored(over: Partial<StoredSession> = {}): StoredSession {
  return {
    session_id: 's1',
    title: 'Untitled',
    cloud_agent_session_id: null,
    parent_session_id: null,
    organization_id: null,
    created_on_platform: 'cli',
    git_url: null,
    git_branch: null,
    status: null,
    status_updated_at: null,
    total_cost_microdollars: null,
    created_at: '2026-07-01 00:00:00+00',
    updated_at: '2026-07-01 00:00:00+00',
    version: 0,
    associatedPr: null,
    ...over,
  };
}

describe('buildRows', () => {
  it('yields no rows when there are no live sessions', () => {
    const rows = buildRows({
      activeSessions: [],
      storedSessions: [],
      activeSessionIds: new Set(),
    });
    expect(rows).toEqual([]);
  });

  it('yields one row for one active session', () => {
    const active = makeActive();
    const rows = buildRows({
      activeSessions: [active],
      storedSessions: [],
      activeSessionIds: new Set([active.id]),
    });
    expect(rows.map(row => row.key)).toEqual(['active:a1']);
  });

  it('caps the rows at three live sessions', () => {
    const activeSessions = [
      makeActive({ id: 'a1' }),
      makeActive({ id: 'a2' }),
      makeActive({ id: 'a3' }),
      makeActive({ id: 'a4' }),
    ];
    const rows = buildRows({
      activeSessions,
      storedSessions: [],
      activeSessionIds: new Set(['a1', 'a2', 'a3', 'a4']),
    });
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.kind === 'active')).toBe(true);
  });

  it('drops an offline stored session', () => {
    const offline = makeStored({ session_id: 'off1', created_on_platform: 'cloud-agent' });
    const rows = buildRows({
      activeSessions: [],
      storedSessions: [offline],
      activeSessionIds: new Set(),
    });
    expect(rows).toEqual([]);
  });

  it('keeps a live cloud-agent stored session', () => {
    const live = makeStored({ session_id: 'on1', created_on_platform: 'cloud-agent' });
    const rows = buildRows({
      activeSessions: [],
      storedSessions: [live],
      activeSessionIds: new Set(['on1']),
    });
    expect(rows.map(row => row.key)).toEqual(['stored:on1']);
  });
});

describe('Home See-all navigation', () => {
  beforeEach(() => {
    navigateSpy.mockClear();
    dismissToSpy.mockClear();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('switches to the Agents index and dismisses the history subpage', async () => {
    const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
      current: undefined,
    };
    await act(async () => {
      await Promise.resolve();
      rendererRef.current = TestRenderer.create(
        createElement(AgentSessionsSection, { organizationId: 'org-1' })
      );
    });
    const renderer = rendererRef.current;
    if (!renderer) {
      throw new Error('renderer was not created');
    }

    const header = renderer.root.find(
      node => typeof node.type === 'string' && (node.type as string) === 'SectionHeader'
    );
    const onActionPress = header.props.onActionPress as () => void;
    expect(onActionPress).toBeTypeOf('function');

    onActionPress();
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(dismissToSpy).toHaveBeenCalledTimes(1);
    const href = navigateSpy.mock.calls[0]?.[0] as string;
    const dismissHref = dismissToSpy.mock.calls[0]?.[0] as string;
    expect(href).toBe('/(app)/(tabs)/(2_agents)/');
    expect(href).not.toContain('history');
    expect(dismissHref).toBe('/(app)/(tabs)/(2_agents)/');
    expect(dismissHref).not.toContain('history');
    expect(navigateSpy.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      dismissToSpy.mock.invocationCallOrder[0] ?? 0
    );

    renderer.unmount();
  });
});
