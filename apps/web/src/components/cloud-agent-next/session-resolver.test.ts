import { createWebSessionResolver } from './session-resolver';
import type { KiloSessionId } from '@kilocode/cloud-agent-sdk';

const kiloSessionId = 'ses_12345678901234567890123456' as KiloSessionId;
const cloudAgentSessionId = 'workspace_12345678-1234-4234-9234-123456789abc';

function fixture() {
  const readCachedCloudSessionId = jest.fn<string | null, [KiloSessionId]>(() => null);
  const readCachedActiveSessions = jest.fn((): { id: string }[] => []);
  const getSession = jest.fn(async () => ({ cloud_agent_session_id: null as string | null }));
  const listActiveSessions = jest.fn(async () => ({ sessions: [] as { id: string }[] }));
  const resolve = createWebSessionResolver({
    readCachedCloudSessionId,
    readCachedActiveSessions,
    getSession,
    listActiveSessions,
  });
  return {
    resolve,
    readCachedCloudSessionId,
    readCachedActiveSessions,
    getSession,
    listActiveSessions,
  };
}

describe('web session resolution', () => {
  it('opens a known Cloud chat without redundant identity or CLI-presence requests', async () => {
    const f = fixture();
    f.readCachedCloudSessionId.mockReturnValue(cloudAgentSessionId);
    await expect(f.resolve(kiloSessionId)).resolves.toEqual({
      type: 'cloud-agent',
      kiloSessionId,
      cloudAgentSessionId,
    });
    expect(f.getSession).not.toHaveBeenCalled();
    expect(f.listActiveSessions).not.toHaveBeenCalled();
  });

  it('resolves an unknown Cloud chat without consulting CLI presence', async () => {
    const f = fixture();
    f.getSession.mockResolvedValue({ cloud_agent_session_id: cloudAgentSessionId });
    await expect(f.resolve(kiloSessionId)).resolves.toMatchObject({
      type: 'cloud-agent',
      cloudAgentSessionId,
    });
    expect(f.listActiveSessions).not.toHaveBeenCalled();
  });

  it('uses cached live CLI presence without waiting for the database', async () => {
    const f = fixture();
    f.readCachedActiveSessions.mockReturnValue([{ id: kiloSessionId }]);
    await expect(f.resolve(kiloSessionId)).resolves.toEqual({ type: 'remote', kiloSessionId });
    expect(f.getSession).not.toHaveBeenCalled();
    expect(f.listActiveSessions).not.toHaveBeenCalled();
  });

  it('still discovers a live CLI session when it is not cached', async () => {
    const f = fixture();
    f.listActiveSessions.mockResolvedValue({ sessions: [{ id: kiloSessionId }] });
    await expect(f.resolve(kiloSessionId)).resolves.toEqual({ type: 'remote', kiloSessionId });
  });

  it('does not treat an empty cached identity as a cloud transport', async () => {
    const f = fixture();
    f.readCachedCloudSessionId.mockReturnValue('');
    f.getSession.mockResolvedValue({ cloud_agent_session_id: cloudAgentSessionId });
    await expect(f.resolve(kiloSessionId)).resolves.toMatchObject({
      type: 'cloud-agent',
      cloudAgentSessionId,
    });
    expect(f.getSession).toHaveBeenCalledWith(kiloSessionId);
  });

  it('keeps stored history available during presence or identity lookup outages', async () => {
    const f = fixture();
    f.getSession.mockRejectedValue(new Error('offline'));
    f.listActiveSessions.mockRejectedValue(new Error('offline'));
    await expect(f.resolve(kiloSessionId)).resolves.toEqual({ type: 'read-only', kiloSessionId });
  });
});
