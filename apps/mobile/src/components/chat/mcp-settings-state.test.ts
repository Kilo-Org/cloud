import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { type Tool } from '@kilocode/harness-sdk';

import { type RemoteMcpServerState } from '@/lib/chat/remote-mcp';
import { type RemoteMcpServerDraft, type StoredRemoteMcpServer } from '@/lib/chat/remote-mcp-store';

import {
  kiloServerRow,
  mcpServerFormError,
  mcpSettingsView,
  remoteServerRows,
  settingsToolsView,
} from './mcp-settings-state';

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

describe('the settings tools switch', () => {
  it('reads on and green when the group is sent to the model', () => {
    expect(settingsToolsView(true)).toEqual({
      titleKey: 'modelChat.mcp.settingsToolsTitle',
      subtitleKey: 'modelChat.mcp.settingsToolsSubtitle',
      statusKey: 'modelChat.mcp.settingsToolsOn',
      tone: 'good',
    });
  });

  it('reads off and grey when the group is not sent', () => {
    expect(settingsToolsView(false)).toMatchObject({
      statusKey: 'modelChat.mcp.settingsToolsOff',
      tone: 'muted',
    });
  });
});

const stored = (over: Partial<StoredRemoteMcpServer> = {}): StoredRemoteMcpServer => ({
  id: 'remote',
  name: 'Remote',
  url: 'https://remote.example/mcp',
  auth: { type: 'none' },
  enabled: true,
  ...over,
});

const discovered = (over: Partial<RemoteMcpServerState> = {}): RemoteMcpServerState => ({
  id: 'remote',
  name: 'Remote',
  url: 'https://remote.example/mcp',
  enabled: true,
  status: 'idle',
  toolCount: 0,
  retryable: false,
  ...over,
});

describe('the remote server rows', () => {
  it('gives every remote row enable, edit and delete', () => {
    const rows = remoteServerRows(
      [stored()],
      [discovered({ status: 'ready', toolCount: 3, retryable: false })]
    );

    expect(rows).toEqual([
      {
        id: 'remote',
        name: 'Remote',
        url: 'https://remote.example/mcp',
        enabled: true,
        statusKey: 'modelChat.mcp.serverToolCount',
        toolCount: 3,
        retry: false,
        canEdit: true,
        canDelete: true,
      },
    ]);
  });

  it('says a disabled server is off, and counts no tools for it', () => {
    const rows = remoteServerRows(
      [stored({ enabled: false })],
      [discovered({ enabled: false, status: 'ready', toolCount: 4 })]
    );

    expect(rows[0]).toMatchObject({
      enabled: false,
      statusKey: 'modelChat.mcp.off',
      toolCount: 0,
    });
  });

  it('reads a server the discovery has not reached as none, not as a failure', () => {
    const rows = remoteServerRows([stored()], []);

    expect(rows[0]).toMatchObject({ statusKey: 'modelChat.mcp.none', toolCount: 0 });
  });

  it('says a server is being checked while its discovery runs', () => {
    const rows = remoteServerRows([stored()], [discovered({ status: 'connecting' })]);

    expect(rows[0]).toMatchObject({ statusKey: 'modelChat.mcp.serverChecking', toolCount: 0 });
  });

  it('says a server could not be reached when its discovery failed', () => {
    const rows = remoteServerRows(
      [stored()],
      [discovered({ status: 'failed', toolCount: 0, retryable: true })]
    );

    expect(rows[0]).toMatchObject({
      statusKey: 'modelChat.mcp.serverUnreachable',
      toolCount: 0,
      retry: true,
    });
  });

  it('offers a Retry only on the row whose discovery failed', () => {
    const rows = remoteServerRows(
      [stored({ id: 'a' }), stored({ id: 'b' }), stored({ id: 'c', enabled: false })],
      [
        discovered({ id: 'a', status: 'failed', retryable: true }),
        discovered({ id: 'b', status: 'ready', toolCount: 2 }),
        discovered({ id: 'c', enabled: false, status: 'failed', retryable: true }),
      ]
    );

    expect(rows.map(row => row.retry)).toEqual([true, false, false]);
  });

  it('offers no Retry on a server the discovery has not reached yet', () => {
    const rows = remoteServerRows([stored()], []);

    expect(rows[0]?.retry).toBe(false);
  });

  it('says a server answered with no tools', () => {
    const rows = remoteServerRows([stored()], [discovered({ status: 'ready', toolCount: 0 })]);

    expect(rows[0]).toMatchObject({ statusKey: 'modelChat.mcp.none', toolCount: 0 });
  });

  it('keeps the stored order and one row per server', () => {
    const rows = remoteServerRows(
      [stored({ id: 'a', name: 'A' }), stored({ id: 'b', name: 'B', enabled: false })],
      [discovered({ id: 'b' }), discovered({ id: 'a', status: 'ready', toolCount: 1 })]
    );

    expect(rows.map(row => row.id)).toEqual(['a', 'b']);
    expect(rows[0]?.toolCount).toBe(1);
  });
});

describe('the Kilo row', () => {
  it('offers enable and disable only', () => {
    const row = kiloServerRow(mcpSettingsView({ status: 'ready', tools: [] }, true));

    expect(row).toMatchObject({
      enabled: true,
      statusKey: 'modelChat.mcp.none',
      canEdit: false,
      canDelete: false,
    });
  });

  it('carries the view it was given, so the sheet draws one row shape', () => {
    const view = mcpSettingsView({ status: 'failed', kind: 'unreachable', retryable: true }, true);

    expect(kiloServerRow(view)).toEqual({ ...view, canEdit: false, canDelete: false });
  });
});

const draft = (over: Partial<RemoteMcpServerDraft> = {}): RemoteMcpServerDraft => ({
  name: 'Remote',
  url: 'https://remote.example/mcp',
  auth: { type: 'none' },
  enabled: true,
  ...over,
});

describe('the server form', () => {
  it('asks for a name', () => {
    expect(mcpServerFormError(draft({ name: '   ' }))).toEqual({ name: 'common.required' });
  });

  it('asks for a URL', () => {
    expect(mcpServerFormError(draft({ url: '' }))).toEqual({ url: 'common.required' });
  });

  it('refuses a URL the store would refuse', () => {
    expect(mcpServerFormError(draft({ url: 'ftp://remote.example/mcp' }))).toEqual({
      url: 'modelChat.mcp.fieldUrlInvalid',
    });
  });

  it('names both fields at once, so neither is hidden behind the other', () => {
    expect(mcpServerFormError(draft({ name: '', url: 'not a url' }))).toEqual({
      name: 'common.required',
      url: 'modelChat.mcp.fieldUrlInvalid',
    });
  });

  it('passes a draft that is ready to save, with or without a token', () => {
    expect(mcpServerFormError(draft())).toBeNull();
    expect(mcpServerFormError(draft({ auth: { type: 'bearer', token: 'secret' } }))).toBeNull();
  });
});
