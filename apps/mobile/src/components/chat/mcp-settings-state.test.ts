import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { type Tool } from '@kilocode/harness-sdk';

import { mcpSettingsView } from './mcp-settings-state';

/**
 * The five states the Kilo MCP control draws.
 *
 * The connection is the module's (`KiloMcpState`), the setting is the chat's,
 * and this is the one place the two become what the sheet shows. Each state is
 * pinned here: the line, the count, the switch, and whether a Retry is offered.
 */

const tool = (name: string): Tool => ({
  definition: {
    name,
    description: '',
    parameters: { type: 'object', properties: {} },
  },
  run: () => Effect.succeed(''),
});

describe('what the Kilo MCP sheet shows', () => {
  it('lists the tools the server answered with, and offers no CTA', () => {
    const view = mcpSettingsView(
      { status: 'ready', tools: [tool('mcp_kilo_read-file'), tool('mcp_kilo_list-files')] },
      true
    );

    expect(view).toMatchObject({
      enabled: true,
      statusKey: 'modelChat.mcp.available',
      toolCount: 2,
      retry: false,
      busy: false,
    });
  });

  it('offers a Retry when the server could not be reached', () => {
    const view = mcpSettingsView({ status: 'failed', kind: 'unreachable', retryable: true }, true);

    expect(view).toMatchObject({
      enabled: true,
      statusKey: 'modelChat.mcp.unreachable',
      retry: true,
      busy: false,
    });
  });

  it('names a refused credential, and still offers a Retry', () => {
    const view = mcpSettingsView({ status: 'failed', kind: 'unauthorized', retryable: true }, true);

    expect(view).toMatchObject({
      statusKey: 'modelChat.mcp.unauthorized',
      retry: true,
    });
  });

  it('offers no CTA and reads off when the server is not there', () => {
    const view = mcpSettingsView({ status: 'failed', kind: 'missing', retryable: false }, true);

    expect(view).toMatchObject({
      enabled: false,
      statusKey: 'modelChat.mcp.unavailable',
      retry: false,
    });
  });

  it('says there are none when the server answered with an empty list', () => {
    const view = mcpSettingsView({ status: 'ready', tools: [] }, true);

    expect(view).toMatchObject({
      enabled: true,
      statusKey: 'modelChat.mcp.none',
      toolCount: 0,
      retry: false,
    });
  });

  it('reads off, with no server contacted, when the chat has the setting off', () => {
    const view = mcpSettingsView({ status: 'ready', tools: [tool('mcp_kilo_read-file')] }, false);

    expect(view).toMatchObject({
      enabled: false,
      statusKey: 'modelChat.mcp.off',
      toolCount: 0,
      retry: false,
      busy: false,
    });
  });

  it('shows the switch working while a discovery is in flight', () => {
    const view = mcpSettingsView({ status: 'connecting' }, true);

    expect(view).toMatchObject({
      enabled: true,
      statusKey: 'modelChat.mcp.connecting',
      busy: true,
      retry: false,
    });
  });
});
