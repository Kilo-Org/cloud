import { describe, expect, it, vi } from 'vitest';

import { hasDisplayableAgentSessions } from '@/components/home/agent-sessions-section';
import { type ActiveSession, type StoredSession } from '@/lib/hooks/use-agent-sessions';

vi.mock('expo-router', () => ({
  useRouter: vi.fn(),
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

vi.mock('@/components/ui/text', () => ({
  Text: () => null,
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

describe('hasDisplayableAgentSessions', () => {
  it('returns true when there is at least one active session', () => {
    expect(hasDisplayableAgentSessions([], [makeActive()])).toBe(true);
  });

  it('returns true when a cloud-agent stored session exists', () => {
    expect(
      hasDisplayableAgentSessions([makeStored({ created_on_platform: 'cloud-agent' })], [])
    ).toBe(true);
    expect(
      hasDisplayableAgentSessions([makeStored({ created_on_platform: 'cloud-agent-web' })], [])
    ).toBe(true);
  });

  it('returns false when only non-cloud-agent stored sessions exist', () => {
    expect(hasDisplayableAgentSessions([makeStored({ created_on_platform: 'cli' })], [])).toBe(
      false
    );
  });

  it('returns false when both arrays are empty', () => {
    expect(hasDisplayableAgentSessions([], [])).toBe(false);
  });
});
