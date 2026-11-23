import { describe, expect, it, jest } from '@jest/globals';
import { readEgressHosts } from './egress-evidence';

describe('readEgressHosts', () => {
  it('continues from an audit cursor and excludes hosts that cannot enter the allowlist', async () => {
    const getEgressAudit = jest
      .fn<
        (input: unknown) => Promise<{
          records: Array<{ decision: 'allowed' | 'denied'; hostname: string; port: number }>;
          nextCursor: number | null;
        }>
      >()
      .mockResolvedValue({
        records: [
          { decision: 'allowed', hostname: 'CDN.Example.com:443', port: 443 },
          { decision: 'allowed', hostname: '127.0.0.1', port: 80 },
          { decision: 'allowed', hostname: '[::1]', port: 80 },
          { decision: 'allowed', hostname: 'localhost', port: 80 },
        ],
        nextCursor: null,
      });
    expect(
      await readEgressHosts({ getEgressAudit } as never, 'workspace_setup', 'org-1', 1000)
    ).toEqual({
      hosts: [{ host: 'cdn.example.com', requestCount: 1, deniedRequestCount: 0 }],
      nextCursor: null,
    });
    expect(getEgressAudit).toHaveBeenCalledWith({
      cloudAgentSessionId: 'workspace_setup',
      limit: 100,
      organizationId: 'org-1',
      cursor: 1000,
    });
  });

  it('counts allowed and denied requests across pages by lowercase hostname', async () => {
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

    const audit = await readEgressHosts({ getEgressAudit } as never, 'workspace_child');

    expect(audit).toEqual({
      hosts: [
        { host: 'registry.example.com', requestCount: 2, deniedRequestCount: 2 },
        { host: 'allowed.example.com', requestCount: 1, deniedRequestCount: 0 },
        { host: 'cdn.example.com', requestCount: 1, deniedRequestCount: 1 },
      ],
      nextCursor: null,
    });
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

    const audit = await readEgressHosts({ getEgressAudit } as never, 'workspace_child', 'org-1');

    expect(getEgressAudit).toHaveBeenCalledTimes(10);
    expect(audit).toEqual({
      hosts: [{ host: 'registry.example.com', requestCount: 10, deniedRequestCount: 10 }],
      nextCursor: 1,
    });
    expect(getEgressAudit).toHaveBeenLastCalledWith({
      cloudAgentSessionId: 'workspace_child',
      limit: 100,
      cursor: 1,
      organizationId: 'org-1',
    });
  });
});
