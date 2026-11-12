import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { toFetchedSessionData } from './fetched-session-data';

describe('toFetchedSessionData environment', () => {
  const session = {
    cloud_agent_session_id: 'workspace_12345678-1234-1234-1234-123456789abc',
    title: 'Workspace',
    organization_id: null,
    git_url: 'https://github.com/Kilo-Org/cloud.git',
    git_branch: 'kilo/workspace',
    cloud_agent_worktree_id: null,
    associatedPr: null,
    total_cost_microdollars: null,
  };
  const kiloSessionId = 'ses_workspace' as KiloSessionId;

  it('preserves the environment ID from runtime state', () => {
    const environmentId = '11111111-1111-4111-8111-111111111111';
    const result = toFetchedSessionData(kiloSessionId, {
      ...session,
      runtimeState: {
        sessionId: session.cloud_agent_session_id,
        userId: 'owner',
        environmentId,
        execution: null,
        timestamp: 1,
        version: 1,
      },
    });

    expect(result.environmentId).toBe(environmentId);
  });

  it('leaves the environment empty when runtime state is unavailable', () => {
    const result = toFetchedSessionData(kiloSessionId, { ...session, runtimeState: null });

    expect(result.environmentId).toBeNull();
  });

  it('preserves explicit maintenance metadata independently of runtime state', () => {
    const result = toFetchedSessionData(kiloSessionId, {
      ...session,
      runtimeState: null,
      chat_kind: 'maintenance',
      maintenance_watch_id: '11111111-1111-4111-8111-111111111111',
      maintenance_attempt_id: '22222222-2222-4222-8222-222222222222',
      is_maintenance_pinned: true,
    });
    expect(result.chatKind).toBe('maintenance');
    expect(result.maintenanceWatchId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.maintenanceAttemptId).toBe('22222222-2222-4222-8222-222222222222');
    expect(result.isMaintenancePinned).toBe(true);
    expect(toFetchedSessionData(kiloSessionId, { ...session, runtimeState: null }).chatKind).toBe(
      'user'
    );
  });
});
