import type { ActiveSession } from '@/lib/active-sessions-list';
import { listActiveSessions } from '@/lib/active-sessions-list';

jest.mock('@/lib/active-sessions-list', () => ({
  listActiveSessions: jest.fn(),
}));

import { buildGlanceableSnapshotForUser } from './glanceable-agents-snapshot-server';

const mockedListActiveSessions = listActiveSessions as jest.MockedFunction<
  typeof listActiveSessions
>;

describe('buildGlanceableSnapshotForUser', () => {
  beforeEach(() => {
    mockedListActiveSessions.mockReset();
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
      },
    ];
    mockedListActiveSessions.mockResolvedValue({ sessions });

    const snapshot = await buildGlanceableSnapshotForUser({
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
  });
});
