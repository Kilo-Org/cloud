import { describe, expect, it } from 'vitest';

import { type RemoteMcpServerState } from '@/lib/chat/remote-mcp-state';
import { type RemoteMcpServerDraft, type StoredRemoteMcpServer } from '@/lib/chat/remote-mcp-store';

import { mcpServerFormError, remoteServerRows } from './mcp-settings-state';

/**
 * The rows the Kilo MCP sheet draws for its remote servers, and the form that
 * adds or edits one. Every row is pinned for the state its discovery reached,
 * and the form for the fields it refuses and the drafts it lets through. The
 * Kilo row's own states are pinned in `mcp-settings-state.test.ts`.
 */

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
        signIn: false,
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
      statusKey: 'modelChat.mcp.serverOff',
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

  it('offers a Sign in, and no Retry, on an OAuth server that needs the person', () => {
    const rows = remoteServerRows(
      [stored({ auth: { type: 'oauth' } }), stored({ id: 'off', enabled: false })],
      [
        discovered({ status: 'signIn' }),
        discovered({ id: 'off', enabled: false, status: 'signIn' }),
      ]
    );

    expect(rows[0]).toMatchObject({
      statusKey: 'modelChat.mcpOAuth.serverNeedsSignIn',
      signIn: true,
      retry: false,
    });
    expect(rows[1]?.signIn).toBe(false);
  });

  it('says a server answered with no tools, and offers a Retry', () => {
    const rows = remoteServerRows(
      [stored()],
      [discovered({ status: 'ready', toolCount: 0, retryable: true })]
    );

    expect(rows[0]).toMatchObject({ statusKey: 'modelChat.mcp.none', toolCount: 0, retry: true });
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

  it('passes a draft that is ready to save, with no sign-in, a token, or OAuth', () => {
    expect(mcpServerFormError(draft())).toBeNull();
    expect(mcpServerFormError(draft({ auth: { type: 'bearer', token: 'secret' } }))).toBeNull();
    expect(mcpServerFormError(draft({ auth: { type: 'oauth' } }))).toBeNull();
  });

  it('asks for the token of a bearer server', () => {
    expect(mcpServerFormError(draft({ auth: { type: 'bearer' } }))).toEqual({
      token: 'common.required',
    });
  });
});
