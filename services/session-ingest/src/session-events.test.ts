import { describe, expect, it, vi } from 'vitest';

vi.mock('./dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));

import { mapSessionEventRow } from './session-events';

describe('mapSessionEventRow', () => {
  it('normalizes Postgres timestamp text before emitting session events', () => {
    const session = mapSessionEventRow({
      session_id: 'ses_12345678901234567890123456',
      created_at: '2026-04-29 01:16:12.945+00',
      updated_at: '2026-04-29 02:17:13.123+00',
      title: 'Fix issue',
      created_on_platform: 'cloud-agent',
      organization_id: null,
      git_url: null,
      git_branch: null,
      parent_session_id: null,
      status: 'busy',
      status_updated_at: '2026-04-29 03:18:14.456+00',
    });

    expect(session.createdAt).toBe('2026-04-29T01:16:12.945Z');
    expect(session.updatedAt).toBe('2026-04-29T02:17:13.123Z');
    expect(session.statusUpdatedAt).toBe('2026-04-29T03:18:14.456Z');
  });
});
