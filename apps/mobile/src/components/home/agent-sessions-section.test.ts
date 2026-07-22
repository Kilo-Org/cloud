import { describe, expect, it, vi } from 'vitest';

import { activeSessionLabel } from '@/components/home/agent-sessions-section';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';

vi.mock('expo-router', () => ({
  useRouter: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('@/components/home/section-header', () => ({
  SectionHeader: () => null,
}));

vi.mock('@/components/ui/session-row', () => ({
  SessionRow: () => null,
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

function makeActiveSession(over: Partial<ActiveSession> = {}): ActiveSession {
  return {
    id: 'test-id',
    status: 'running',
    title: 'Test Session',
    connectionId: 'conn-1',
    ...over,
  };
}

describe('activeSessionLabel', () => {
  it('returns repo name uppercased when gitUrl is present', () => {
    const session = makeActiveSession({
      gitUrl: 'git@github.com:org/my-repo.git',
      createdOnPlatform: 'cli',
    });
    expect(activeSessionLabel(session)).toBe('MY-REPO');
  });

  it('returns "LIVE" when createdOnPlatform is undefined and no repo', () => {
    const session = makeActiveSession({
      createdOnPlatform: undefined,
      gitUrl: undefined,
    });
    expect(activeSessionLabel(session)).toBe('LIVE');
  });

  it('returns "LIVE" when createdOnPlatform is empty string and no repo', () => {
    const session = makeActiveSession({
      createdOnPlatform: '',
      gitUrl: undefined,
    });
    expect(activeSessionLabel(session)).toBe('LIVE');
  });

  it('returns "LIVE" when createdOnPlatform is "unknown" and no repo', () => {
    const session = makeActiveSession({
      createdOnPlatform: 'unknown',
      gitUrl: undefined,
    });
    expect(activeSessionLabel(session)).toBe('LIVE');
  });

  it('returns "CLI" when createdOnPlatform is "cli" and no repo', () => {
    const session = makeActiveSession({
      createdOnPlatform: 'cli',
      gitUrl: undefined,
    });
    expect(activeSessionLabel(session)).toBe('CLI');
  });

  it('returns "CLOUD AGENT" when createdOnPlatform is "cloud-agent-web" and no repo', () => {
    const session = makeActiveSession({
      createdOnPlatform: 'cloud-agent-web',
      gitUrl: undefined,
    });
    expect(activeSessionLabel(session)).toBe('CLOUD AGENT');
  });
});
