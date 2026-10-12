import type { ActiveSession } from '@/lib/active-sessions-list';
import { listActiveSessions } from '@/lib/active-sessions-list';
import { readCloudAgentWidgetApprovalKey } from '@/lib/cloud-agent-next/cloud-agent-client';
import { db } from '@kilocode/web-shared/lib/drizzle';

jest.mock('@/lib/active-sessions-list', () => ({
  listActiveSessions: jest.fn(),
}));
jest.mock('@/lib/cloud-agent-next/cloud-agent-client', () => ({
  readCloudAgentWidgetApprovalKey: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: { select: jest.fn() } }));

import { buildHomeWidgetResponseForUser } from './glanceable-agents-snapshot-server';

const mockedListActiveSessions = listActiveSessions as jest.MockedFunction<
  typeof listActiveSessions
>;
const mockedReadApprovalKey = jest.mocked(readCloudAgentWidgetApprovalKey);
const limit = jest.fn(
  async (_count: number): Promise<{ cloudAgentSessionId: string | null }[]> => []
);
const where = jest.fn(() => ({ limit }));

const KEY = 'a'.repeat(64);
const CLOUD_SESSION = 'workspace_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('buildHomeWidgetResponseForUser', () => {
  beforeEach(() => {
    mockedListActiveSessions.mockReset();
    mockedReadApprovalKey.mockReset();
    limit.mockReset();
    limit.mockResolvedValue([]);
    jest.mocked(db.select).mockReset();
    jest.mocked(db.select).mockReturnValue({ from: () => ({ where }) } as never);
  });

  it('copies no forbidden session field into the snapshot', async () => {
    const sessions: (ActiveSession & { organizationName?: string })[] = [
      {
        id: 'ses_raw_1',
        status: 'busy',
        title: 'Secret prompt',
        connectionId: 'conn-1',
        gitUrl: 'github.com/acme/repo',
        organizationName: 'Acme Org',
        organizationId: 'org-9',
      },
      {
        id: 'ses_raw_2',
        status: 'question',
        title: 'Another secret',
        connectionId: 'conn-2',
        statusUpdatedAt: '2026-08-27T10:00:00.000Z',
      },
    ];
    mockedListActiveSessions.mockResolvedValue({ sessions });

    const { snapshot } = await buildHomeWidgetResponseForUser({
      userId: 'oauth/user-1',
      organizationId: 'org-9',
    });

    const json = JSON.stringify(snapshot);
    expect(json).not.toContain('Secret prompt');
    expect(json).not.toContain('Another secret');
    expect(json).not.toContain('github.com/acme/repo');
    expect(json).not.toContain('ses_raw_1');
    expect(json).not.toContain('ses_raw_2');
    expect(json).not.toContain('Acme Org');
    expect(json).not.toContain('oauth/user-1');
    expect(json).not.toContain('org-9');

    expect(snapshot.status).toBe('happy');
    expect(snapshot.running).toBe(1);
    expect(snapshot.needsInput).toBe(1);
    // A timestamp is the one session-derived value the snapshot may carry.
    expect(snapshot.needsInputSince).toBe('2026-08-27T10:00:00.000Z');
  });

  it('reports no wait when nothing needs input', async () => {
    mockedListActiveSessions.mockResolvedValue({
      sessions: [
        {
          id: 'ses_raw_3',
          status: 'busy',
          title: 'Running',
          connectionId: 'conn-3',
          statusUpdatedAt: '2026-08-27T10:00:00.000Z',
        },
      ],
    });

    const { snapshot } = await buildHomeWidgetResponseForUser({
      userId: 'oauth/user-1',
      organizationId: null,
    });

    expect(snapshot.running).toBe(1);
    expect(snapshot.needsInputSince).toBeNull();
  });

  it('builds private Home details and generic counts from one complete authorized list', async () => {
    mockedListActiveSessions.mockResolvedValue({
      sessions: [
        {
          id: 'raw-session',
          status: 'permission',
          title: 'Home only',
          connectionId: 'raw-connection',
        },
      ],
    });
    const response = await buildHomeWidgetResponseForUser({
      userId: 'oauth/user-1',
      organizationId: null,
    });
    expect(mockedListActiveSessions).toHaveBeenCalledTimes(1);
    expect(mockedListActiveSessions).toHaveBeenCalledWith({
      userId: 'oauth/user-1',
      organizationId: null,
      includeCloudAgentSessions: true,
      requireCompleteSnapshot: true,
    });
    expect(response.snapshot.needsInput).toBe(1);
    expect(response.home.primaryKind).toBe('needsInput');
    expect(response.home.primaryTitle).toBe('Home only');
    expect(response.refreshAt).toBe(Date.parse(response.snapshot.updatedAt) + 30 * 60 * 1000);
    expect(JSON.stringify(response.snapshot)).not.toContain('Home only');
    expect(JSON.stringify(response)).not.toContain('raw-session');
    expect(JSON.stringify(response)).not.toContain('raw-connection');
  });

  it('does not synthesize a successful Home response from an upstream failure', async () => {
    mockedListActiveSessions.mockRejectedValue(new Error('source unavailable'));
    await expect(
      buildHomeWidgetResponseForUser({ userId: 'oauth/user-1', organizationId: null })
    ).rejects.toThrow('source unavailable');
  });

  describe('approval identity', () => {
    const permissionRows: ActiveSession[] = [
      {
        id: 'ses_newer_permission',
        status: 'permission',
        title: 'Newer approval',
        connectionId: 'cloud-agent',
        statusUpdatedAt: '2026-10-09T09:00:00.000Z',
      },
      { id: 'ses_running', status: 'busy', title: 'Running', connectionId: 'cloud-agent' },
      {
        id: 'ses_oldest_permission',
        status: 'permission',
        title: 'Oldest approval',
        connectionId: 'cloud-agent',
        statusUpdatedAt: '2026-10-09T08:00:00.000Z',
      },
    ];

    it('binds only the oldest approvable cloud permission and ranks it first', async () => {
      mockedListActiveSessions.mockResolvedValue({ sessions: permissionRows });
      limit.mockResolvedValue([{ cloudAgentSessionId: CLOUD_SESSION }]);
      mockedReadApprovalKey.mockResolvedValue(KEY);

      const response = await buildHomeWidgetResponseForUser({
        userId: 'oauth/user-1',
        organizationId: 'org-9',
      });

      expect(mockedReadApprovalKey).toHaveBeenCalledTimes(1);
      expect(mockedReadApprovalKey).toHaveBeenCalledWith(
        {
          userId: 'oauth/user-1',
          organizationId: 'org-9',
          kiloSessionId: 'ses_oldest_permission',
          cloudAgentSessionId: CLOUD_SESSION,
        },
        undefined
      );
      expect(response.details.approvalKey).toBe(KEY);
      expect(response.home).toMatchObject({
        approvalKey: KEY,
        canApprove: true,
        primaryTitle: 'Oldest approval',
      });
      expect(JSON.stringify(response.snapshot)).not.toContain(KEY);
      const json = JSON.stringify(response);
      for (const raw of ['ses_oldest_permission', 'ses_newer_permission', CLOUD_SESSION]) {
        expect(json).not.toContain(raw);
      }
    });

    it('keeps valid counts and omits approval when the identity read fails', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockedListActiveSessions.mockResolvedValue({ sessions: permissionRows });
      limit.mockResolvedValue([{ cloudAgentSessionId: CLOUD_SESSION }]);
      mockedReadApprovalKey.mockRejectedValue(new Error(`upstream ${CLOUD_SESSION} perm_secret`));

      const response = await buildHomeWidgetResponseForUser({
        userId: 'oauth/user-1',
        organizationId: null,
      });

      expect(response.snapshot.needsInput).toBe(2);
      expect(response.snapshot.running).toBe(1);
      expect(response.details.approvalKey).toBeNull();
      expect(response.home).toMatchObject({ approvalKey: null, canApprove: false });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(CLOUD_SESSION);
      expect(logged).not.toContain('perm_secret');
      expect(logged).not.toContain('ses_oldest_permission');
      expect(logged).not.toContain('oauth/user-1');
      warn.mockRestore();
    });

    it('asks for no identity when the approvable row is a remote CLI session', async () => {
      mockedListActiveSessions.mockResolvedValue({ sessions: permissionRows });
      limit.mockResolvedValue([{ cloudAgentSessionId: null }]);

      const response = await buildHomeWidgetResponseForUser({
        userId: 'oauth/user-1',
        organizationId: null,
      });

      expect(mockedReadApprovalKey).not.toHaveBeenCalled();
      expect(response.details.approvalKey).toBeNull();
    });

    it('reads nothing when no permission row waits', async () => {
      mockedListActiveSessions.mockResolvedValue({
        sessions: [
          { id: 'ses_question', status: 'question', title: 'Answer', connectionId: 'cloud-agent' },
        ],
      });

      const response = await buildHomeWidgetResponseForUser({
        userId: 'oauth/user-1',
        organizationId: null,
      });

      expect(db.select).not.toHaveBeenCalled();
      expect(mockedReadApprovalKey).not.toHaveBeenCalled();
      expect(response.home.canApprove).toBe(false);
    });
  });
});
