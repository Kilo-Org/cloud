import { describe, expect, it, jest } from '@jest/globals';
import { readDeniedHosts } from './egress-evidence';

describe('readDeniedHosts', () => {
  it('counts denied records across pages by lowercase hostname', async () => {
    const getEgressAudit = jest
      .fn<
        (input: unknown) => Promise<{
          records: Array<{ decision: 'allowed' | 'denied'; hostname: string; port: number }>;
          nextCursor: number | null;
        }>
      >()
      .mockResolvedValueOnce({
        records: [
          { decision: 'denied', hostname: 'Registry.Example.com', port: 443 },
          { decision: 'allowed', hostname: 'allowed.example.com', port: 443 },
        ],
        nextCursor: 2,
      })
      .mockResolvedValueOnce({
        records: [
          { decision: 'denied', hostname: 'registry.example.com', port: 80 },
          { decision: 'denied', hostname: 'cdn.example.com', port: 443 },
        ],
        nextCursor: null,
      });

    const denied = await readDeniedHosts({ getEgressAudit } as never, 'workspace_child');

    expect(denied).toEqual(
      new Map([
        ['registry.example.com', 2],
        ['cdn.example.com', 1],
      ])
    );
    expect(getEgressAudit).toHaveBeenNthCalledWith(1, {
      cloudAgentSessionId: 'workspace_child',
      limit: 100,
    });
    expect(getEgressAudit).toHaveBeenNthCalledWith(2, {
      cloudAgentSessionId: 'workspace_child',
      limit: 100,
      cursor: 2,
    });
  });

  it('stops after ten pages', async () => {
    const getEgressAudit = jest
      .fn<
        (input: unknown) => Promise<{
          records: Array<{ decision: 'allowed' | 'denied'; hostname: string; port: number }>;
          nextCursor: number | null;
        }>
      >()
      .mockResolvedValue({
        records: [{ decision: 'denied', hostname: 'registry.example.com', port: 443 }],
        nextCursor: 1,
      });

    const denied = await readDeniedHosts({ getEgressAudit } as never, 'workspace_child', 'org-1');

    expect(getEgressAudit).toHaveBeenCalledTimes(10);
    expect(denied.get('registry.example.com')).toBe(10);
    expect(getEgressAudit).toHaveBeenLastCalledWith({
      cloudAgentSessionId: 'workspace_child',
      limit: 100,
      cursor: 1,
      organizationId: 'org-1',
    });
  });
});
