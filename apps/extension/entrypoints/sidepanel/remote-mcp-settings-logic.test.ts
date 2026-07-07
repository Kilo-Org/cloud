import { describe, expect, it } from 'vitest';
import type { RemoteMcpStore } from '../../src/shared/remote-mcp';
import {
  applyUpsert,
  buildDraftFromForm,
  formatLastConnected,
  formatToolCount,
  getConnectButtonLabel,
  isSecretSaved,
  removeServer,
  toolsToJsonString,
} from './remote-mcp-settings-logic';

const makeServer = (overrides: Partial<Parameters<typeof isSecretSaved>[0]> = {}) => ({
  allowInSafeMode: false,
  auth: { type: 'none' as const },
  cachedTools: [],
  displayName: 'Test',
  enabled: true,
  id: 'test-id',
  slug: 'test',
  status: 'untested' as const,
  url: 'https://example.com/mcp',
  ...overrides,
});

const makeStore = (servers: ReturnType<typeof makeServer>[] = []): RemoteMcpStore => ({ servers });

describe('remote-mcp-settings pure logic', () => {
  describe('connect button label', () => {
    it('returns Connect for untested', () => {
      expect(getConnectButtonLabel('untested')).toBe('Connect');
    });

    it('returns Connect for needs_auth', () => {
      expect(getConnectButtonLabel('needs_auth')).toBe('Connect');
    });

    it('returns Refresh for connected', () => {
      expect(getConnectButtonLabel('connected')).toBe('Refresh');
    });

    it('returns Refresh for unavailable', () => {
      expect(getConnectButtonLabel('unavailable')).toBe('Refresh');
    });
  });

  describe('upsert', () => {
    it('returns new store on success', () => {
      const store = makeStore();
      const draft = {
        allowInSafeMode: false,
        auth: { type: 'none' as const },
        displayName: 'My Server',
        enabled: true,
        url: 'https://example.com/mcp',
      };
      const { store: nextStore, error } = applyUpsert(store, draft);
      expect(error).toBeNull();
      expect(nextStore.servers).toHaveLength(1);
      expect(nextStore.servers[0]?.displayName).toBe('My Server');
    });

    it('returns error string for duplicate URL', () => {
      const existingServer = makeServer({ id: 'id-1', url: 'https://example.com/mcp' });
      const store = makeStore([existingServer]);
      const draft = {
        allowInSafeMode: false,
        auth: { type: 'none' as const },
        displayName: 'Duplicate',
        enabled: true,
        id: 'id-2',
        url: 'https://example.com/mcp',
      };
      const { store: resultStore, error } = applyUpsert(store, draft);
      expect(error).not.toBeNull();
      expect(resultStore).toBe(store);
    });
  });

  describe('server removal', () => {
    it('removes the server by id', () => {
      const s1 = makeServer({ id: 'a', url: 'https://a.example.com/mcp' });
      const s2 = makeServer({ id: 'b', url: 'https://b.example.com/mcp' });
      const store = makeStore([s1, s2]);
      const result = removeServer(store, 'a');
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0]?.id).toBe('b');
    });

    it('leaves other servers unchanged when id not found', () => {
      const s1 = makeServer({ id: 'a', url: 'https://a.example.com/mcp' });
      const s2 = makeServer({ id: 'b', url: 'https://b.example.com/mcp' });
      const store = makeStore([s1, s2]);
      const result = removeServer(store, 'nonexistent');
      expect(result.servers).toHaveLength(2);
    });
  });

  describe('tool count formatting', () => {
    it('uses singular for 1', () => {
      expect(formatToolCount(1)).toBe('1 tool');
    });

    it('uses plural for 0', () => {
      expect(formatToolCount(0)).toBe('0 tools');
    });

    it('uses plural for 3', () => {
      expect(formatToolCount(3)).toBe('3 tools');
    });
  });

  describe('last connected formatting', () => {
    it('returns Never when no date', () => {
      expect(formatLastConnected()).toBe('Never');
    });

    it('returns just now for recent', () => {
      const now = new Date(Date.now() - 10_000).toISOString();
      expect(formatLastConnected(now)).toBe('just now');
    });

    it('returns minutes ago', () => {
      const ago = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(formatLastConnected(ago)).toBe('5 minutes ago');
    });

    it('uses singular for 1 minute', () => {
      const ago = new Date(Date.now() - 90_000).toISOString();
      expect(formatLastConnected(ago)).toBe('1 minute ago');
    });

    it('returns hours ago', () => {
      const ago = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      expect(formatLastConnected(ago)).toBe('3 hours ago');
    });

    it('uses singular for 1 hour', () => {
      const ago = new Date(Date.now() - 90 * 60 * 1000).toISOString();
      expect(formatLastConnected(ago)).toBe('1 hour ago');
    });

    it('returns days ago', () => {
      const ago = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatLastConnected(ago)).toBe('3 days ago');
    });
  });

  describe('tools JSON serialization', () => {
    it('returns valid JSON string', () => {
      const tools = [{ inputSchema: {}, name: 'my_tool' }];
      const result = toolsToJsonString(tools);
      expect(JSON.parse(result)).toStrictEqual(tools);
    });

    it('returns empty array JSON for no tools', () => {
      expect(toolsToJsonString([])).toBe('[]');
    });
  });

  describe('draft from form', () => {
    const baseFields = {
      allowInSafeMode: false,
      bearerToken: '',
      displayName: 'Test',
      enabled: true,
      headerName: 'X-Key',
      headerValue: '',
      url: 'https://example.com/mcp',
    };

    it('bearer edit — empty field + existing token preserves existing token', () => {
      const draft = buildDraftFromForm(
        { ...baseFields, authType: 'bearer' },
        { token: 'saved-tok', type: 'bearer' }
      );
      expect(draft.auth).toStrictEqual({ token: 'saved-tok', type: 'bearer' });
    });

    it('bearer edit — new value typed overrides existing token', () => {
      const draft = buildDraftFromForm(
        { ...baseFields, authType: 'bearer', bearerToken: 'new-tok' },
        { token: 'saved-tok', type: 'bearer' }
      );
      expect(draft.auth).toStrictEqual({ token: 'new-tok', type: 'bearer' });
    });

    it('header edit — empty field + existing headerValue preserves existing value', () => {
      const draft = buildDraftFromForm(
        { ...baseFields, authType: 'header' },
        { headerName: 'X-Key', headerValue: 'saved-val', type: 'header' }
      );
      expect(draft.auth).toStrictEqual({
        headerName: 'X-Key',
        headerValue: 'saved-val',
        type: 'header',
      });
    });

    it('header edit — new value typed overrides existing value', () => {
      const draft = buildDraftFromForm(
        { ...baseFields, authType: 'header', headerValue: 'new-val' },
        { headerName: 'X-Key', headerValue: 'saved-val', type: 'header' }
      );
      expect(draft.auth).toStrictEqual({
        headerName: 'X-Key',
        headerValue: 'new-val',
        type: 'header',
      });
    });

    it('add-new bearer with token — token present', () => {
      const draft = buildDraftFromForm({ ...baseFields, authType: 'bearer', bearerToken: 'tok' });
      expect(draft.auth).toStrictEqual({ token: 'tok', type: 'bearer' });
    });

    it('add-new bearer with empty token — no token field', () => {
      const draft = buildDraftFromForm({ ...baseFields, authType: 'bearer' });
      expect(draft.auth).toStrictEqual({ type: 'bearer' });
    });
  });

  describe('secret saved check', () => {
    it('returns false when no server', () => {
      expect(isSecretSaved()).toBe(false);
    });

    it('returns false for none auth', () => {
      expect(isSecretSaved(makeServer({ auth: { type: 'none' } }))).toBe(false);
    });

    it('returns true for bearer with token', () => {
      expect(isSecretSaved(makeServer({ auth: { token: 'tok', type: 'bearer' } }))).toBe(true);
    });

    it('returns false for bearer without token', () => {
      expect(isSecretSaved(makeServer({ auth: { type: 'bearer' } }))).toBe(false);
    });

    it('returns true for header with headerValue', () => {
      expect(
        isSecretSaved(
          makeServer({ auth: { headerName: 'X-Key', headerValue: 'val', type: 'header' } })
        )
      ).toBe(true);
    });

    it('returns false for header without headerValue', () => {
      expect(isSecretSaved(makeServer({ auth: { headerName: 'X-Key', type: 'header' } }))).toBe(
        false
      );
    });

    it('returns false for oauth', () => {
      expect(isSecretSaved(makeServer({ auth: { type: 'oauth' } }))).toBe(false);
    });
  });
});
