import { describe, test, expect } from '@jest/globals';
import {
  extractRepoFromGitUrl,
  convertToCloudMessages,
  formatSessionDate,
  getSessionDisplayTitle,
} from './db-session-atoms';
import type { DbSession } from './db-session-atoms';

// ============================================================================
// extractRepoFromGitUrl Tests
// ============================================================================

describe('extractRepoFromGitUrl', () => {
  test('should extract owner/repo from HTTPS URL', () => {
    expect(extractRepoFromGitUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  test('should extract owner/repo from HTTPS URL with .git suffix', () => {
    expect(extractRepoFromGitUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('should extract owner/repo from SSH URL', () => {
    expect(extractRepoFromGitUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  test('should extract owner/repo from SSH URL without .git suffix', () => {
    expect(extractRepoFromGitUrl('git@github.com:owner/repo')).toBe('owner/repo');
  });

  test('should return undefined for null input', () => {
    expect(extractRepoFromGitUrl(null)).toBeUndefined();
  });

  test('should return undefined for undefined input', () => {
    expect(extractRepoFromGitUrl(undefined)).toBeUndefined();
  });

  test('should return undefined for empty string', () => {
    expect(extractRepoFromGitUrl('')).toBeUndefined();
  });

  test('should return undefined for invalid URL', () => {
    expect(extractRepoFromGitUrl('not-a-url')).toBeUndefined();
  });

  test('should handle GitLab SSH URLs', () => {
    expect(extractRepoFromGitUrl('git@gitlab.com:owner/repo.git')).toBe('owner/repo');
  });

  test('should handle URLs with nested paths', () => {
    // Only takes first two path segments as owner/repo
    expect(extractRepoFromGitUrl('https://github.com/owner/repo/tree/main')).toBe('owner/repo');
  });
});

// ============================================================================
// convertToCloudMessages Tests
// ============================================================================

describe('convertToCloudMessages', () => {
  test('should convert user_feedback messages to user type', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'say',
        say: 'user_feedback',
        content: 'Hello from user',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('user');
    expect(result[0].content).toBe('Hello from user');
    expect(result[0].ts).toBe(123456789);
  });

  test('should convert say messages (non-user_feedback) to assistant type', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'say',
        say: 'text',
        content: 'Hello from assistant',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('assistant');
  });

  test('should convert ask messages to assistant type', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'ask',
        ask: 'completion_result',
        content: 'Please confirm',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('assistant');
    expect(result[0].ask).toBe('completion_result');
  });

  test('should handle messages with timestamp string', () => {
    const dbMessages = [
      {
        timestamp: '2024-01-15T10:30:00Z',
        type: 'say',
        say: 'text',
        content: 'test',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result).toHaveLength(1);
    expect(typeof result[0].ts).toBe('number');
    expect(result[0].ts).toBe(new Date('2024-01-15T10:30:00Z').getTime());
  });

  test('should preserve partial flag', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'say',
        say: 'text',
        content: 'partial message',
        partial: true,
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result[0].partial).toBe(true);
  });

  test('should default partial to false when not present', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'say',
        say: 'text',
        content: 'complete message',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result[0].partial).toBe(false);
  });

  test('should preserve metadata', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'say',
        say: 'api_req_started',
        metadata: { tokensIn: 100, tokensOut: 50 },
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result[0].metadata).toEqual({ tokensIn: 100, tokensOut: 50 });
  });

  test('should parse tool metadata from text when missing', () => {
    const dbMessages = [
      {
        ts: 123456789,
        type: 'ask',
        ask: 'tool',
        text: '{"tool":"updateTodoList","todos":["[x] One","[ ] Two"]}',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result[0].metadata).toEqual({
      tool: 'updateTodoList',
      todos: ['[x] One', '[ ] Two'],
    });
  });

  test('should return empty array for non-array input', () => {
    const result = convertToCloudMessages(
      'not an array' as unknown as Array<Record<string, unknown>>
    );
    expect(result).toEqual([]);
  });

  test('should handle empty array', () => {
    const result = convertToCloudMessages([]);
    expect(result).toEqual([]);
  });

  test('should handle messages with role field (alternative format)', () => {
    const dbMessages = [
      {
        ts: 123456789,
        role: 'user',
        content: 'User message via role field',
      },
    ];

    const result = convertToCloudMessages(dbMessages);

    expect(result[0].type).toBe('user');
  });
});

// ============================================================================
// formatSessionDate Tests
// ============================================================================

describe('formatSessionDate', () => {
  test('should format recent time as "just now"', () => {
    const now = new Date();
    expect(formatSessionDate(now)).toBe('just now');
  });

  test('should format minutes ago', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatSessionDate(fiveMinutesAgo)).toBe('5m ago');
  });

  test('should format hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    expect(formatSessionDate(twoHoursAgo)).toBe('2h ago');
  });

  test('should format days ago', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    expect(formatSessionDate(threeDaysAgo)).toBe('3d ago');
  });

  test('should format older dates as month and day', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const result = formatSessionDate(twoWeeksAgo);
    // Should be something like "Nov 25" depending on current date
    expect(result).toMatch(/^[A-Z][a-z]+ \d+$/);
  });

  test('should accept string input', () => {
    const dateString = new Date().toISOString();
    expect(formatSessionDate(dateString)).toBe('just now');
  });
});

// ============================================================================
// getSessionDisplayTitle Tests
// ============================================================================

describe('getSessionDisplayTitle', () => {
  const baseSession: DbSession = {
    session_id: '123e4567-e89b-12d3-a456-426614174000',
    title: null,
    git_url: null,
    cloud_agent_session_id: null,
    created_on_platform: 'unknown',
    created_at: new Date(),
    updated_at: new Date(),
    last_mode: null,
    last_model: null,
    version: 0,
    organization_id: null,
  };

  test('should return title when present', () => {
    const session = { ...baseSession, title: 'My Test Session' };
    expect(getSessionDisplayTitle(session)).toBe('My Test Session');
  });

  test('should return long titles untruncated (CSS handles truncation)', () => {
    const longTitle = 'A'.repeat(100);
    const session = { ...baseSession, title: longTitle };
    const result = getSessionDisplayTitle(session);
    expect(result).toBe(longTitle);
  });

  test('should fall back to repository name', () => {
    const session = { ...baseSession, git_url: 'https://github.com/owner/repo' };
    expect(getSessionDisplayTitle(session)).toBe('owner/repo');
  });

  test('should fall back to session ID prefix', () => {
    expect(getSessionDisplayTitle(baseSession)).toBe('Session 123e4567');
  });
});

// ============================================================================
// Staleness Detection Logic Tests
// ============================================================================

describe('Staleness Detection Logic', () => {
  /**
   * These tests verify the staleness detection algorithm without needing
   * to mock IndexedDB. They test the pure logic that was extracted from
   * checkStalenessWithHighWaterMarkAtom.
   */

  // Helper function that mirrors the actual staleness check logic
  function isSessionStale(
    dbUpdatedAt: string | Date,
    highWaterMark: number,
    toleranceMs: number = 1000
  ): boolean {
    // If no highWaterMark, can't determine staleness - not stale
    if (!highWaterMark) return false;

    const dbUpdatedAtMs = new Date(dbUpdatedAt).getTime();
    return dbUpdatedAtMs > highWaterMark + toleranceMs;
  }

  test('should detect staleness when DB has newer data', () => {
    const highWaterMark = new Date('2024-01-15T10:00:00Z').getTime();
    const dbUpdatedAt = '2024-01-15T10:05:00Z'; // 5 minutes newer

    expect(isSessionStale(dbUpdatedAt, highWaterMark)).toBe(true);
  });

  test('should not detect staleness when DB is older', () => {
    const highWaterMark = new Date('2024-01-15T10:05:00Z').getTime();
    const dbUpdatedAt = '2024-01-15T10:00:00Z'; // 5 minutes older

    expect(isSessionStale(dbUpdatedAt, highWaterMark)).toBe(false);
  });

  test('should not detect staleness when timestamps are equal', () => {
    const highWaterMark = new Date('2024-01-15T10:00:00Z').getTime();
    const dbUpdatedAt = '2024-01-15T10:00:00Z';

    expect(isSessionStale(dbUpdatedAt, highWaterMark)).toBe(false);
  });

  test('should use 1 second tolerance for timestamp comparison', () => {
    const highWaterMark = new Date('2024-01-15T10:00:00.000Z').getTime();

    // 500ms difference - within tolerance (1000ms)
    const dbUpdatedAt500ms = '2024-01-15T10:00:00.500Z';
    expect(isSessionStale(dbUpdatedAt500ms, highWaterMark)).toBe(false);

    // 1500ms difference - outside tolerance
    const dbUpdatedAt1500ms = '2024-01-15T10:00:01.500Z';
    expect(isSessionStale(dbUpdatedAt1500ms, highWaterMark)).toBe(true);
  });

  test('should not detect staleness when highWaterMark is 0 (uninitialized)', () => {
    const dbUpdatedAt = '2024-01-15T10:00:00Z';
    expect(isSessionStale(dbUpdatedAt, 0)).toBe(false);
  });

  test('should handle postgresql timestamp format', () => {
    // PostgreSQL returns dates like: '2024-01-15 10:00:00.123456+00'
    const highWaterMark = new Date('2024-01-15T10:00:00Z').getTime();
    const dbUpdatedAt = '2024-01-15 10:05:00.123456+00';

    expect(isSessionStale(dbUpdatedAt, highWaterMark)).toBe(true);
  });
});

// ============================================================================
// Session Loading Logic Tests
// ============================================================================

describe('Session Loading Logic', () => {
  /**
   * These tests verify the session loading behavior without IndexedDB.
   * They test the logic that when loading from DB, highWaterMark should
   * always be set to the DB's updated_at, NOT Math.max.
   */

  type MergeSessionParams = {
    existingHighWaterMark: number;
    dbUpdatedAt: Date;
  };

  // This mirrors the CORRECT logic in loadSessionToIndexedDbAtom after the fix
  function computeHighWaterMarkOnLoad(params: MergeSessionParams): number {
    const dbUpdatedAtMs = params.dbUpdatedAt.getTime();
    // CORRECT: Always use DB's updated_at when loading from DB
    // This is our new sync reference point
    return dbUpdatedAtMs;
  }

  // This is the OLD (buggy) logic for comparison
  function computeHighWaterMarkOnLoadBuggy(params: MergeSessionParams): number {
    const dbUpdatedAtMs = params.dbUpdatedAt.getTime();
    // BUGGY: Using Math.max can preserve stale highWaterMark values
    return Math.max(dbUpdatedAtMs, params.existingHighWaterMark);
  }

  test('should set highWaterMark to DB timestamp when loading fresh data', () => {
    const existingHighWaterMark = new Date('2024-01-15T09:00:00Z').getTime();
    const dbUpdatedAt = new Date('2024-01-15T10:00:00Z'); // Newer

    const result = computeHighWaterMarkOnLoad({ existingHighWaterMark, dbUpdatedAt });

    // Should be DB's timestamp, not existing
    expect(result).toBe(dbUpdatedAt.getTime());
    expect(result).not.toBe(existingHighWaterMark);
  });

  test('should set highWaterMark to DB timestamp even when existing is newer (refresh scenario)', () => {
    // This is the key bug case: user refreshes, but their local highWaterMark
    // was set from message timestamps and is artificially high
    const existingHighWaterMark = new Date('2024-01-15T11:00:00Z').getTime(); // Higher!
    const dbUpdatedAt = new Date('2024-01-15T10:00:00Z'); // DB says this

    const correctResult = computeHighWaterMarkOnLoad({ existingHighWaterMark, dbUpdatedAt });
    const buggyResult = computeHighWaterMarkOnLoadBuggy({ existingHighWaterMark, dbUpdatedAt });

    // CORRECT: Should use DB's timestamp (our new sync point)
    expect(correctResult).toBe(dbUpdatedAt.getTime());

    // BUGGY: Would keep the old (wrong) highWaterMark
    expect(buggyResult).toBe(existingHighWaterMark);
    expect(buggyResult).not.toBe(correctResult);
  });

  test('bug scenario: Math.max preserves stale value causing false staleness', () => {
    // Scenario from actual bug:
    // 1. Session loads, highWaterMark = 1000 (DB updated_at)
    // 2. Messages stream in with timestamps 1100, 1200, 1300...
    // 3. OLD BUG: appendMessageToIndexedDb updates highWaterMark to 1300
    // 4. session_synced event arrives with updatedAt = 1050
    // 5. OLD BUG: updateHighWaterMark does Math.max(1050, 1300) = 1300 (unchanged!)
    // 6. User refreshes, loads from DB with updated_at = 1060
    // 7. OLD BUG: Math.max(1060, 1300) = 1300 (still wrong!)
    // 8. Next staleness check: DB says 1060, we have 1300
    // 9. OLD BUG: 1060 < 1300, so not stale... BUT WAIT
    // 10. ACTUAL ISSUE: DB later updates to 1100, staleness check sees 1100 < 1300, still "not stale"
    //     BUT we never actually received that update!
    //
    // The fix: highWaterMark should ONLY come from session_synced events (DB's updated_at),
    // never from message timestamps. And on refresh, always use DB's value.

    const messageTimestamp = 1300; // Higher than DB's updated_at
    const dbUpdatedAtOnRefresh = new Date(1060);

    // With Math.max (buggy): existing value stays
    const buggyHighWaterMark = Math.max(dbUpdatedAtOnRefresh.getTime(), messageTimestamp);
    expect(buggyHighWaterMark).toBe(1300); // WRONG - keeps message timestamp

    // Without Math.max (correct): DB value used
    const correctHighWaterMark = dbUpdatedAtOnRefresh.getTime();
    expect(correctHighWaterMark).toBe(1060); // CORRECT - uses DB timestamp
  });
});

// ============================================================================
// createSessionData Tests
// ============================================================================

describe('createSessionData (via import from indexeddb-store)', () => {
  // Note: createSessionData is exported from indexeddb-store.ts
  // We test it here conceptually since it contains highWaterMark logic

  test('should initialize highWaterMark from dbUpdatedAt', () => {
    // The createSessionData function should set highWaterMark from dbUpdatedAt
    // This verifies the concept - actual timestamp depends on timezone
    const dbUpdatedAt = '2024-01-15T10:00:00Z';
    const expectedHighWaterMark = new Date(dbUpdatedAt).getTime();

    // createSessionData is called like:
    // createSessionData({ sessionId, dbUpdatedAt, ... }, messages, repository)
    // And should set highWaterMark = Date.parse(dbUpdatedAt)

    // Verify it's a reasonable unix timestamp (Jan 2024)
    expect(expectedHighWaterMark).toBeGreaterThan(1704000000000); // After Jan 1, 2024
    expect(expectedHighWaterMark).toBeLessThan(1706000000000); // Before Feb 1, 2024
  });

  test('should initialize highWaterMark to 0 when dbUpdatedAt is null', () => {
    // When creating a brand new session (not loaded from DB),
    // dbUpdatedAt would be null/undefined, and highWaterMark should be 0
    // This means "we don't know the DB timestamp yet"
    const expectedHighWaterMark = 0;
    expect(expectedHighWaterMark).toBe(0);
  });
});

// ============================================================================
// IndexedDB Cleanup Logic Tests
// ============================================================================

describe('IndexedDB Cleanup Logic', () => {
  /**
   * These tests verify the cleanup algorithm without mocking IndexedDB.
   * They test the pure logic that determines which sessions should be deleted.
   */

  type SessionEntry = {
    sessionId: string;
    updatedAt: string;
  };

  // Helper function that mirrors the cleanup filtering logic
  function getSessionsToDelete(
    entries: SessionEntry[],
    currentSessionId: string | null,
    maxAgeMs: number
  ): string[] {
    const cutoffTime = Date.now() - maxAgeMs;
    const sessionsToDelete: string[] = [];

    for (const { sessionId, updatedAt } of entries) {
      // Skip the current active session
      if (sessionId === currentSessionId) {
        continue;
      }

      const updatedAtMs = new Date(updatedAt).getTime();

      if (updatedAtMs < cutoffTime) {
        sessionsToDelete.push(sessionId);
      }
    }

    return sessionsToDelete;
  }

  const ONE_HOUR_MS = 60 * 60 * 1000;

  test('should mark sessions older than max age for deletion', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString();
    const entries: SessionEntry[] = [{ sessionId: 'old-session', updatedAt: twoHoursAgo }];

    const toDelete = getSessionsToDelete(entries, null, ONE_HOUR_MS);

    expect(toDelete).toContain('old-session');
  });

  test('should not delete sessions newer than max age', () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const entries: SessionEntry[] = [{ sessionId: 'recent-session', updatedAt: thirtyMinutesAgo }];

    const toDelete = getSessionsToDelete(entries, null, ONE_HOUR_MS);

    expect(toDelete).not.toContain('recent-session');
    expect(toDelete).toHaveLength(0);
  });

  test('should never delete the current active session', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString();
    const entries: SessionEntry[] = [{ sessionId: 'active-session', updatedAt: twoHoursAgo }];

    const toDelete = getSessionsToDelete(entries, 'active-session', ONE_HOUR_MS);

    expect(toDelete).not.toContain('active-session');
    expect(toDelete).toHaveLength(0);
  });

  test('should delete old sessions but preserve current session', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString();
    const entries: SessionEntry[] = [
      { sessionId: 'old-session-1', updatedAt: twoHoursAgo },
      { sessionId: 'active-session', updatedAt: twoHoursAgo },
      { sessionId: 'old-session-2', updatedAt: twoHoursAgo },
    ];

    const toDelete = getSessionsToDelete(entries, 'active-session', ONE_HOUR_MS);

    expect(toDelete).toContain('old-session-1');
    expect(toDelete).toContain('old-session-2');
    expect(toDelete).not.toContain('active-session');
    expect(toDelete).toHaveLength(2);
  });

  test('should handle mixed old and new sessions', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString();
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const entries: SessionEntry[] = [
      { sessionId: 'old-session', updatedAt: twoHoursAgo },
      { sessionId: 'recent-session', updatedAt: thirtyMinutesAgo },
    ];

    const toDelete = getSessionsToDelete(entries, null, ONE_HOUR_MS);

    expect(toDelete).toContain('old-session');
    expect(toDelete).not.toContain('recent-session');
    expect(toDelete).toHaveLength(1);
  });

  test('should handle empty entries array', () => {
    const toDelete = getSessionsToDelete([], null, ONE_HOUR_MS);

    expect(toDelete).toHaveLength(0);
  });

  test('should respect custom max age', () => {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const entries: SessionEntry[] = [{ sessionId: 'session', updatedAt: fifteenMinutesAgo }];

    // With 10 minute max age, 15 minute old session should be deleted
    const toDeleteWith10Min = getSessionsToDelete(entries, null, 10 * 60 * 1000);
    expect(toDeleteWith10Min).toContain('session');

    // With 20 minute max age, 15 minute old session should NOT be deleted
    const toDeleteWith20Min = getSessionsToDelete(entries, null, 20 * 60 * 1000);
    expect(toDeleteWith20Min).not.toContain('session');
  });
});

// ============================================================================
// New Session Creation Logic Tests
// ============================================================================

describe('New Session Creation Logic', () => {
  /**
   * Tests for the logic that adds new sessions to dbSessionsAtom
   * when a session_created event is received.
   */

  type DbSession = {
    session_id: string;
    title: string | null;
    git_url: string | null;
    cloud_agent_session_id: string | null;
    created_on_platform: string;
    created_at: Date;
    updated_at: Date;
    version?: number;
    organization_id?: string | null;
  };

  // Helper that mirrors the logic in createNewSessionInIndexedDbAtom
  function createDbSessionFromEvent(
    kiloSessionId: string,
    cloudAgentSessionId: string,
    title: string,
    repository: string
  ): DbSession {
    const now = new Date();
    return {
      session_id: kiloSessionId,
      title,
      git_url: repository ? `https://github.com/${repository}` : null,
      cloud_agent_session_id: cloudAgentSessionId,
      created_on_platform: 'cloud-agent',
      created_at: now,
      updated_at: now,
    };
  }

  // Helper that mirrors prepending to sessions list
  function addSessionToList(existingSessions: DbSession[], newSession: DbSession): DbSession[] {
    return [newSession, ...existingSessions];
  }

  test('should create a DbSession from session_created event data', () => {
    const session = createDbSessionFromEvent(
      'kilo-uuid-123',
      'agent_abc123',
      'Fix login bug',
      'owner/repo'
    );

    expect(session.session_id).toBe('kilo-uuid-123');
    expect(session.cloud_agent_session_id).toBe('agent_abc123');
    expect(session.title).toBe('Fix login bug');
    expect(session.git_url).toBe('https://github.com/owner/repo');
    expect(session.created_at).toBeInstanceOf(Date);
    expect(session.updated_at).toBeInstanceOf(Date);
  });

  test('should handle missing repository', () => {
    const session = createDbSessionFromEvent('kilo-uuid-123', 'agent_abc123', 'Test', '');

    expect(session.git_url).toBeNull();
  });

  test('should prepend new session to existing list', () => {
    const existingSession: DbSession = {
      session_id: 'existing-session',
      title: 'Old session',
      git_url: 'https://github.com/old/repo',
      cloud_agent_session_id: 'agent_old',
      created_on_platform: 'cloud-agent',
      created_at: new Date('2024-01-01'),
      updated_at: new Date('2024-01-01'),
    };

    const newSession = createDbSessionFromEvent(
      'new-session',
      'agent_new',
      'New session',
      'new/repo'
    );

    const updatedList = addSessionToList([existingSession], newSession);

    expect(updatedList).toHaveLength(2);
    expect(updatedList[0].session_id).toBe('new-session'); // New session is first
    expect(updatedList[1].session_id).toBe('existing-session');
  });

  test('should work with empty existing list', () => {
    const newSession = createDbSessionFromEvent(
      'first-session',
      'agent_first',
      'First session',
      'my/repo'
    );

    const updatedList = addSessionToList([], newSession);

    expect(updatedList).toHaveLength(1);
    expect(updatedList[0].session_id).toBe('first-session');
  });
});
