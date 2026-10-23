import { describe, expect, it } from 'vitest';

import {
  discoveryOf,
  type RemoteMcpDiscovery,
  remoteServerStates,
  remoteServerToolsFor,
  remoteServerViewsFor,
} from './remote-mcp-state';
import { server, stateOf, tool, viewTool } from './remote-mcp.test-helpers';

/**
 * The join between the stored list and the discovery, proven directly: an
 * enabled server merges its tools, a disabled one does not, and a failed or
 * empty discovery offers nothing but a Retry.
 */

describe('the pure helpers', () => {
  it('merges an enabled server’s tools, named for the server', () => {
    const alpha = server({ id: 'alpha' });
    const discovered = new Map<string, RemoteMcpDiscovery>([
      ['alpha', discoveryOf('alpha', [tool('mcp_alpha_read'), tool('mcp_alpha_write')])],
    ]);

    expect(remoteServerToolsFor([alpha], discovered).map(entry => entry.definition.name)).toEqual([
      'mcp_alpha_read',
      'mcp_alpha_write',
    ]);
    expect(remoteServerStates([alpha], discovered)).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 2, retryable: false }),
    ]);
  });

  it('contributes nothing from a disabled server, whatever was cached', () => {
    const alpha = server({ id: 'alpha', enabled: false });
    const discovered = new Map<string, RemoteMcpDiscovery>([
      ['alpha', discoveryOf('alpha', [tool('mcp_alpha_read')])],
    ]);

    expect(remoteServerToolsFor([alpha], discovered)).toEqual([]);
    expect(remoteServerStates([alpha], discovered)).toEqual([
      stateOf(alpha, { status: 'idle', toolCount: 0, retryable: false }),
    ]);
  });

  it('keeps two servers’ tools distinct', () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta' });
    const discovered = new Map<string, RemoteMcpDiscovery>([
      ['alpha', discoveryOf('alpha', [tool('mcp_alpha_read')])],
      ['beta', discoveryOf('beta', [tool('mcp_beta_read')])],
    ]);

    expect(
      remoteServerToolsFor([alpha, beta], discovered).map(entry => entry.definition.name)
    ).toEqual(['mcp_alpha_read', 'mcp_beta_read']);
  });

  it('leaves a failed discovery failed and offers none of its tools', () => {
    const alpha = server({ id: 'alpha' });
    const discovered = new Map<string, RemoteMcpDiscovery>([
      ['alpha', { ...discoveryOf('alpha', [tool('mcp_alpha_read')]), failed: true }],
    ]);

    expect(remoteServerToolsFor([alpha], discovered)).toEqual([]);
    expect(remoteServerStates([alpha], discovered)).toEqual([
      stateOf(alpha, { status: 'failed', toolCount: 0, retryable: true }),
    ]);
  });

  it('leaves a server that was never asked idle', () => {
    const alpha = server({ id: 'alpha' });

    expect(remoteServerStates([alpha], new Map())).toEqual([
      stateOf(alpha, { status: 'idle', toolCount: 0, retryable: false }),
    ]);
  });

  it('keeps a view only for the tools that carry one', () => {
    const alpha = server({ id: 'alpha' });
    const beta = server({ id: 'beta', enabled: false });
    const discovered = new Map<string, RemoteMcpDiscovery>([
      [
        'alpha',
        discoveryOf('alpha', [viewTool('mcp_alpha_chart', 'chart', 'ui://alpha/chart.html')]),
      ],
      ['beta', discoveryOf('beta', [viewTool('mcp_beta_chart', 'chart', 'ui://beta/chart.html')])],
    ]);

    expect([...remoteServerViewsFor([alpha, beta], discovered).keys()]).toEqual([
      'mcp_alpha_chart',
    ]);
  });

  it('offers a Retry on a server that answered with no tools', () => {
    const alpha = server({ id: 'alpha' });
    const discovered = new Map<string, RemoteMcpDiscovery>([['alpha', discoveryOf('alpha', [])]]);

    expect(remoteServerStates([alpha], discovered)).toEqual([
      stateOf(alpha, { status: 'ready', toolCount: 0, retryable: true }),
    ]);
  });
});
