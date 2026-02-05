import { describe, it, expect } from '@jest/globals';
import { needsResumeConfigModal, buildStreamResumeConfig } from './useResumeConfigModal';
import type { DbSessionDetails, IndexedDbSessionData } from '../store/db-session-atoms';

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Create a minimal DbSessionDetails for testing.
 * Only includes fields relevant to needsResumeConfigModal logic.
 */
function createDbSession(overrides: Partial<DbSessionDetails> = {}): DbSessionDetails {
  return {
    session_id: 'test-session-id',
    title: 'Test Session',
    git_url: 'https://github.com/owner/repo',
    cloud_agent_session_id: null,
    created_on_platform: 'cli',
    created_at: new Date(),
    updated_at: new Date(),
    last_mode: null,
    last_model: null,
    organization_id: null,
    kilo_user_id: 'user-123',
    forked_from: null,
    api_conversation_history_blob_url: null,
    task_metadata_blob_url: null,
    ui_messages_blob_url: null,
    git_state_blob_url: null,
    ...overrides,
  };
}

/**
 * Create a minimal IndexedDbSessionData for testing.
 */
function createIndexedDbSession(
  overrides: Partial<IndexedDbSessionData> = {}
): IndexedDbSessionData {
  return {
    sessionId: 'test-session-id',
    cloudAgentSessionId: null,
    messages: [],
    highWaterMark: 0,
    loadedFromDbAt: null,
    title: 'Test Session',
    gitUrl: 'https://github.com/owner/repo',
    repository: 'owner/repo',
    orgContext: null,
    orgContextConfirmed: false,
    resumeConfig: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMode: null,
    lastModel: null,
    ...overrides,
  };
}

// ============================================================================
// needsResumeConfigModal Tests
// ============================================================================

describe('needsResumeConfigModal', () => {
  it('returns false when no session is loaded', () => {
    const result = needsResumeConfigModal({
      loadedDbSession: null,
      currentIndexedDbSession: null,
    });

    expect(result).toBe(false);
  });

  it('returns true for CLI session without stored resume config', () => {
    // CLI sessions have no cloud_agent_session_id
    const dbSession = createDbSession({
      cloud_agent_session_id: null,
    });

    const result = needsResumeConfigModal({
      loadedDbSession: dbSession,
      currentIndexedDbSession: null,
    });

    expect(result).toBe(true);
  });

  it('returns false for CLI session WITH stored resume config in IndexedDB', () => {
    const dbSession = createDbSession({
      cloud_agent_session_id: null,
    });

    const indexedDbSession = createIndexedDbSession({
      resumeConfig: {
        mode: 'build',
        model: 'anthropic/claude-3-5-sonnet',
      },
    });

    const result = needsResumeConfigModal({
      loadedDbSession: dbSession,
      currentIndexedDbSession: indexedDbSession,
    });

    expect(result).toBe(false);
  });

  it('returns false for web session with cloud_agent_session_id (mode/model stored in cloud-agent DO)', () => {
    // Web sessions from cli_sessions_v2 with cloud_agent_session_id store mode/model
    // in the cloud-agent Durable Object, so they don't need the resume config modal.
    const dbSession = createDbSession({
      cloud_agent_session_id: 'agent_abc123',
      last_model: null, // last_model in DB doesn't matter for V2 sessions
    });

    const result = needsResumeConfigModal({
      loadedDbSession: dbSession,
      currentIndexedDbSession: null,
    });

    expect(result).toBe(false);
  });

  it('returns false for web session with cloud_agent_session_id even with last_model set', () => {
    // Web sessions with cloud_agent_session_id don't need the modal regardless of last_model
    const dbSession = createDbSession({
      cloud_agent_session_id: 'agent_abc123',
      last_model: 'anthropic/claude-3-5-sonnet',
    });

    const result = needsResumeConfigModal({
      loadedDbSession: dbSession,
      currentIndexedDbSession: null,
    });

    expect(result).toBe(false);
  });
});

// ============================================================================
// buildStreamResumeConfig Tests
// ============================================================================

describe('buildStreamResumeConfig', () => {
  it('returns null when no config sources available', () => {
    const result = buildStreamResumeConfig({
      resumeConfig: null,
      pendingResumeSession: null,
      currentIndexedDbSession: null,
    });

    expect(result).toBeNull();
  });

  it('prioritizes local resumeConfig over IndexedDB stored config', () => {
    const dbSession = createDbSession({
      git_url: 'https://github.com/local/repo',
    });

    const indexedDbSession = createIndexedDbSession({
      repository: 'indexed/db-repo',
      resumeConfig: {
        mode: 'plan',
        model: 'stored-model',
      },
    });

    const result = buildStreamResumeConfig({
      resumeConfig: {
        mode: 'build',
        model: 'local-model',
        envVars: { API_KEY: 'secret' },
      },
      pendingResumeSession: dbSession,
      currentIndexedDbSession: indexedDbSession,
    });

    expect(result).toEqual({
      mode: 'build',
      model: 'local-model',
      envVars: { API_KEY: 'secret' },
      setupCommands: undefined,
      githubRepo: 'local/repo',
    });
  });

  it('falls back to IndexedDB stored config when no local config', () => {
    const indexedDbSession = createIndexedDbSession({
      repository: 'indexed/db-repo',
      resumeConfig: {
        mode: 'plan',
        model: 'stored-model',
        envVars: { DB_KEY: 'value' },
        setupCommands: ['npm install'],
      },
    });

    const result = buildStreamResumeConfig({
      resumeConfig: null,
      pendingResumeSession: null,
      currentIndexedDbSession: indexedDbSession,
    });

    expect(result).toEqual({
      mode: 'plan',
      model: 'stored-model',
      envVars: { DB_KEY: 'value' },
      setupCommands: ['npm install'],
      githubRepo: 'indexed/db-repo',
    });
  });
});
