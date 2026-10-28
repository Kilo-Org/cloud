import {
  canOpenWorkspacePreview,
  gatePreviewSessionId,
  selectPreviewSessionId,
} from './select-preview-session';
import type { StoredSession } from './types';

function makeChat(sessionId: string, cloudAgentSessionId?: string | null): StoredSession {
  return {
    sessionId,
    repository: 'kilo/repository',
    prompt: sessionId,
    mode: 'code',
    model: 'test-model',
    status: 'active',
    createdAt: '2026-08-26T10:00:00.000Z',
    updatedAt: '2026-08-26T10:00:00.000Z',
    messages: [],
    cloudAgentSessionId,
  };
}

describe('selectPreviewSessionId', () => {
  it('uses a sibling when the viewed route is known not ready in a worktree', () => {
    const current = makeChat('ses_current', 'agent_current');

    expect(
      selectPreviewSessionId({
        selectedWorktreeId: 'worktree_1',
        routeReady: false,
        sessionIdFromParams: 'ses_current',
        sessionId: 'agent_current',
        worktreeChats: [current, makeChat('ses_sibling', 'agent_sibling')],
      })
    ).toBe('agent_sibling');
  });

  it('falls back to the current session when an unready chat has no sibling', () => {
    expect(
      selectPreviewSessionId({
        selectedWorktreeId: 'worktree_1',
        routeReady: false,
        sessionIdFromParams: 'ses_current',
        sessionId: 'agent_current',
        worktreeChats: [makeChat('ses_current', 'agent_current')],
      })
    ).toBe('agent_current');
  });

  it('uses the current session without a sibling lookup once its route is ready', () => {
    const current = makeChat('ses_current', 'agent_current');

    expect(
      selectPreviewSessionId({
        selectedWorktreeId: 'worktree_1',
        routeReady: true,
        sessionIdFromParams: 'ses_current',
        sessionId: 'agent_current',
        worktreeChats: [current, makeChat('ses_sibling', 'agent_sibling')],
      })
    ).toBe('agent_current');
  });

  it('does not look for a sibling outside a worktree', () => {
    expect(
      selectPreviewSessionId({
        selectedWorktreeId: null,
        routeReady: false,
        sessionIdFromParams: 'ses_current',
        sessionId: 'agent_current',
        worktreeChats: [makeChat('ses_current', 'agent_current')],
      })
    ).toBe('agent_current');
  });

  it('uses the first worktree chat with a cloud session when none is selected', () => {
    expect(
      selectPreviewSessionId({
        selectedWorktreeId: 'worktree_1',
        routeReady: undefined,
        sessionIdFromParams: null,
        sessionId: null,
        worktreeChats: [makeChat('ses_first'), makeChat('ses_second', 'agent_second')],
      })
    ).toBe('agent_second');
  });

  it('returns null when no worktree chat has a cloud session', () => {
    expect(
      selectPreviewSessionId({
        selectedWorktreeId: 'worktree_1',
        routeReady: undefined,
        sessionIdFromParams: null,
        sessionId: null,
        worktreeChats: [makeChat('ses_first'), makeChat('ses_second', null)],
      })
    ).toBeNull();
  });
});

describe('canOpenWorkspacePreview', () => {
  it('offers a preview only for control-plane workspace sessions', () => {
    expect(canOpenWorkspacePreview('workspace_12345678-1234-4234-9234-123456789abc')).toBe(true);
    expect(canOpenWorkspacePreview('agent_12345678-1234-4234-9234-123456789abc')).toBe(false);
    expect(canOpenWorkspacePreview('ses_12345678901234567890123456')).toBe(false);
    expect(canOpenWorkspacePreview(null)).toBe(false);
    expect(canOpenWorkspacePreview(undefined)).toBe(false);
  });
});

describe('gatePreviewSessionId', () => {
  it('passes a workspace session when the viewer may open a terminal', () => {
    expect(gatePreviewSessionId('workspace_1', true)).toBe('workspace_1');
  });

  it('refuses a workspace session when the viewer may not open a terminal', () => {
    expect(gatePreviewSessionId('workspace_1', false)).toBeNull();
  });

  it('refuses a legacy agent session and no session', () => {
    expect(gatePreviewSessionId('agent_1', true)).toBeNull();
    expect(gatePreviewSessionId(null, true)).toBeNull();
  });
});
