import { describe, expect, it, vi } from 'vitest';

import { buildRows } from '@/components/home/agent-sessions-section';
import { type ActiveSession, type StoredSession } from '@/lib/hooks/use-agent-sessions';

vi.mock('expo-router', () => ({
  useRouter: vi.fn(),
  useFocusEffect: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('@/components/home/section-header', () => ({
  SectionHeader: () => null,
}));

vi.mock('@/components/agents/remote-session-row', () => ({
  RemoteSessionRow: () => null,
}));

vi.mock('@/components/agents/session-row', () => ({
  StoredSessionRow: () => null,
}));

vi.mock('@/components/ui/icons', () => ({
  Plus: () => null,
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
  it('yields three placeholders when there are no live sessions', () => {
    const rows = buildRows({
      activeSessions: [],
      storedSessions: [],
      activeSessionIds: new Set(),
    });
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.kind === 'placeholder')).toBe(true);
    expect(rows.map(row => row.key)).toEqual(['placeholder:0', 'placeholder:1', 'placeholder:2']);
  });

  it('yields one live row and two placeholders for one active session', () => {
    const active = makeActive();
    const rows = buildRows({
      activeSessions: [active],
      storedSessions: [],
      activeSessionIds: new Set([active.id]),
    });
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.kind === 'active')).toHaveLength(1);
    expect(rows.filter(row => row.kind === 'placeholder')).toHaveLength(2);
  });

  it('yields three live rows and zero placeholders for three active sessions', () => {
    const activeSessions = [
      makeActive({ id: 'a1' }),
      makeActive({ id: 'a2' }),
      makeActive({ id: 'a3' }),
    ];
    const rows = buildRows({
      activeSessions,
      storedSessions: [],
      activeSessionIds: new Set(['a1', 'a2', 'a3']),
    });
    expect(rows).toHaveLength(3);
    expect(rows.filter(row => row.kind === 'active')).toHaveLength(3);
    expect(rows.filter(row => row.kind === 'placeholder')).toHaveLength(0);
  });

  it('does not occupy a slot with an offline stored session', () => {
    const offline = makeStored({ session_id: 'off1', created_on_platform: 'cloud-agent' });
    const rows = buildRows({
      activeSessions: [],
      storedSessions: [offline],
      activeSessionIds: new Set(),
    });
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.kind === 'placeholder')).toBe(true);
  });
});
