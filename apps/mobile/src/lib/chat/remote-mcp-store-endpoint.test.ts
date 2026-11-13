import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  addRemoteMcpServer,
  clearRemoteMcpServers,
  listRemoteMcpServers,
  setRemoteMcpServerEnabled,
  updateRemoteMcpServer,
} from './remote-mcp-store';

/**
 * What an edit does to the credential a server holds.
 *
 * A value is saved for one endpoint. These are the claims that an edit cannot
 * carry it to another one, and that every other edit leaves it alone.
 */

const { getItemAsync, setItemAsync, deleteItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync, deleteItemAsync }));

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ captureException }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: toastError } }));

/** A bearer server, so each test names only the edit it is about. */
function saved(name = 'Alpha', url = 'https://a.example/mcp') {
  return addRemoteMcpServer({
    name,
    url,
    auth: { type: 'bearer', token: 'secret' },
    enabled: true,
  });
}

beforeEach(() => {
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  deleteItemAsync.mockReset();
  captureException.mockReset();
  toastError.mockReset();
  clearRemoteMcpServers();
});

describe('editing the endpoint a saved value belongs to', () => {
  it('keeps the value when the edit leaves the endpoint alone', () => {
    const server = saved();

    expect(updateRemoteMcpServer(server.id, { name: 'Alpha Two' }).auth).toEqual({
      type: 'bearer',
      token: 'secret',
    });
    expect(setRemoteMcpServerEnabled(server.id, false).auth).toEqual({
      type: 'bearer',
      token: 'secret',
    });
    expect(updateRemoteMcpServer(server.id, { enabled: true }).auth).toEqual({
      type: 'bearer',
      token: 'secret',
    });
  });

  it('keeps the value when the endpoint is respelled', () => {
    const server = saved();

    const edited = updateRemoteMcpServer(server.id, { url: 'https://a.example/mcp/' });

    expect(edited.url).toBe('https://a.example/mcp');
    expect(edited.auth).toEqual({ type: 'bearer', token: 'secret' });
  });

  it('drops the value when the endpoint changes', () => {
    const server = saved();

    const moved = updateRemoteMcpServer(server.id, { url: 'https://elsewhere.example/mcp' });

    expect(moved.url).toBe('https://elsewhere.example/mcp');
    expect(moved.auth).toEqual({ type: 'bearer' });
    expect(listRemoteMcpServers()[0]).toEqual(moved);
  });

  it('drops the value when the edit echoes it back', () => {
    const server = saved();

    const moved = updateRemoteMcpServer(server.id, {
      name: 'Alpha',
      url: 'https://elsewhere.example/mcp',
      auth: { type: 'bearer', token: 'secret' },
      enabled: true,
    });

    expect(moved.auth).toEqual({ type: 'bearer' });
  });

  it('keeps the value when the edit enters it for the new endpoint', () => {
    const server = saved();

    const moved = updateRemoteMcpServer(server.id, {
      name: 'Alpha',
      url: 'https://elsewhere.example/mcp',
      auth: { type: 'bearer', token: 'secret' },
      enabled: true,
      tokenEntered: true,
    });

    expect(moved.auth).toEqual({ type: 'bearer', token: 'secret' });
    expect(listRemoteMcpServers()[0]).toEqual(moved);
    expect(listRemoteMcpServers()[0]).not.toHaveProperty('tokenEntered');
  });

  it('keeps the value an edit enters for the new endpoint', () => {
    const server = saved();

    const moved = updateRemoteMcpServer(server.id, {
      url: 'https://elsewhere.example/mcp',
      auth: { type: 'bearer', token: 'entered' },
    });

    expect(moved.auth).toEqual({ type: 'bearer', token: 'entered' });
  });

  it('leaves a server with no saved value alone', () => {
    const open = addRemoteMcpServer({
      name: 'Open',
      url: 'https://open.example/mcp',
      auth: { type: 'none' },
      enabled: true,
    });
    const oauth = addRemoteMcpServer({
      name: 'Signed',
      url: 'https://signed.example/mcp',
      auth: { type: 'oauth' },
      enabled: true,
    });

    expect(updateRemoteMcpServer(open.id, { url: 'https://open2.example/mcp' }).auth).toEqual({
      type: 'none',
    });
    expect(updateRemoteMcpServer(oauth.id, { url: 'https://signed2.example/mcp' }).auth).toEqual({
      type: 'oauth',
    });
  });
});
