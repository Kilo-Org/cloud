import { describe, expect, it, vi } from 'vitest';
import type { KiloFacadeHandlerContext } from '../../contracts.js';
import { handlePermission, parsePermissionRoute } from './handler.js';

vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: vi.fn(),
  Sandbox: class Sandbox {},
}));

const rootSessionID = 'ses_12345678901234567890123456';
const childSessionID = 'ses_22222222222222222222222222';
const foreignSessionID = 'ses_33333333333333333333333333';

function permissionContext(params: {
  method?: string;
  path?: string;
  body?: string;
  directory?: string | null;
  responses: Response[];
  containerFetch?: ReturnType<typeof vi.fn>;
}): { context: KiloFacadeHandlerContext; containerFetch: ReturnType<typeof vi.fn> } {
  const path = params.path ?? '/permission';
  const directory =
    params.directory === undefined ? `/cloud-agent/sessions/${rootSessionID}` : params.directory;
  const requestUrl = new URL(`https://facade.test/kilo${path}`);
  if (directory !== null) requestUrl.searchParams.set('directory', directory);
  const request = new Request(requestUrl, {
    method: params.method ?? 'GET',
    ...(params.body !== undefined
      ? { body: params.body, headers: { 'content-type': 'application/json' } }
      : {}),
  });
  const containerFetch = params.containerFetch ?? vi.fn();
  for (const response of params.responses) containerFetch.mockResolvedValueOnce(response);
  return {
    context: {
      request,
      env: {} as KiloFacadeHandlerContext['env'],
      userId: 'user-1',
      url: new URL(request.url),
      kiloPath: path,
      deps: {
        resolveRootSessionForKiloSession: vi
          .fn()
          .mockResolvedValue({ cloudAgentSessionId: 'cloud-1' }),
        resolveLiveWrapper: vi.fn().mockResolvedValue({ sandbox: { containerFetch }, port: 4312 }),
      },
    },
    containerFetch,
  };
}

const rootPermission = {
  id: 'per_root',
  sessionID: rootSessionID,
  permission: 'bash',
  patterns: ['git status', 'git diff *'],
  metadata: { command: 'git status' },
  always: ['git status'],
  tool: { messageID: 'message-root', callID: 'call-root' },
  nativeExtra: true,
};
const childPermission = {
  id: 'per_child',
  sessionID: childSessionID,
  permission: 'read',
  patterns: ['/workspace/*'],
  metadata: {},
  always: [],
};
const foreignPermission = {
  id: 'per_foreign',
  sessionID: foreignSessionID,
  permission: 'edit',
  patterns: ['/workspace/file'],
  metadata: {},
  always: [],
};

describe('permission handler', () => {
  it('recognizes only the allowlisted permission routes', () => {
    expect(parsePermissionRoute('GET', '/permission')).toEqual({ kind: 'list' });
    expect(parsePermissionRoute('POST', '/permission/request-1/reply')).toEqual({
      kind: 'reply',
      requestID: 'request-1',
    });
    expect(parsePermissionRoute('POST', '/permission/request-1/always-rules')).toEqual({
      kind: 'always-rules',
      requestID: 'request-1',
    });
    expect(parsePermissionRoute('POST', '/permission/request%201/reply')).toEqual({
      kind: 'reply',
      requestID: 'request 1',
    });
    expect(parsePermissionRoute('DELETE', '/permission/request-1/reply')).toBeNull();
    expect(parsePermissionRoute('POST', '/permission/request-1/reject')).toBeNull();
    expect(parsePermissionRoute('POST', '/permission/%FF/reply')).toBeNull();
  });

  it('preserves valid native permission entries while filtering non-root permissions', async () => {
    const { context, containerFetch } = permissionContext({
      responses: [Response.json([rootPermission, childPermission, foreignPermission])],
    });

    const response = await handlePermission(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([rootPermission]);
    const request = containerFetch.mock.calls[0]?.[0];
    expect(request).toBeInstanceOf(Request);
    expect(new URL(request.url).pathname).toBe('/kilo-proxy/permission');
    expect(new URL(request.url).search).toBe('');
  });

  it('requires a selected owned root before listing permissions', async () => {
    const { context, containerFetch } = permissionContext({ directory: null, responses: [] });

    const response = await handlePermission(context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_SESSION_SELECTOR_UNSUPPORTED',
    });
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('rejects malformed native permission lists', async () => {
    const malformedEntries = [
      { ...rootPermission, id: 'wrong-permission-root' },
      { ...rootPermission, patterns: ['valid', 1] },
      { ...rootPermission, metadata: [] },
      { ...rootPermission, always: [false] },
      { ...rootPermission, tool: { messageID: 'message-root' } },
    ];

    for (const malformed of malformedEntries) {
      const { context } = permissionContext({ responses: [Response.json([malformed])] });
      const response = await handlePermission(context);
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_UPSTREAM_RESPONSE_INVALID',
      });
    }
  });

  it('preflights and forwards every native permission reply with its native response', async () => {
    const bodies = [
      { reply: 'once' },
      { reply: 'always' },
      { reply: 'reject', message: 'Use the existing file instead' },
    ];

    for (const body of bodies) {
      const nativeResponse = new Response(JSON.stringify({ handled: body.reply }), {
        status: 202,
        headers: { 'content-type': 'application/json', 'x-native': 'preserved' },
      });
      const { context, containerFetch } = permissionContext({
        method: 'POST',
        path: '/permission/per_root/reply',
        body: JSON.stringify(body),
        responses: [Response.json([rootPermission]), nativeResponse],
      });

      const response = await handlePermission(context);

      expect(response.status).toBe(202);
      expect(response.headers.get('x-native')).toBe('preserved');
      await expect(response.json()).resolves.toEqual({ handled: body.reply });
      expect(containerFetch).toHaveBeenCalledTimes(2);
      const mutationRequest = containerFetch.mock.calls[1]?.[0];
      expect(new URL(mutationRequest.url).pathname).toBe('/kilo-proxy/permission/per_root/reply');
      await expect(mutationRequest.json()).resolves.toEqual(body);
    }
  });

  it('rejects malformed reply bodies before resolving or mutating a wrapper', async () => {
    const malformedBodies = [
      {},
      { reply: 'later' },
      { reply: 'once', message: 1 },
      { reply: 'once', extra: true },
    ];

    for (const body of malformedBodies) {
      const { context, containerFetch } = permissionContext({
        method: 'POST',
        path: '/permission/per_root/reply',
        body: JSON.stringify(body),
        responses: [],
      });
      const response = await handlePermission(context);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_INTERACTION_BODY_INVALID',
      });
      expect(containerFetch).not.toHaveBeenCalled();
    }
  });

  it('forwards always rules followed by a compatible reply against the same pending request', async () => {
    const alwaysRulesBody = { approvedAlways: ['git status'], deniedAlways: ['git push *'] };
    const containerFetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json([rootPermission]))
      .mockResolvedValueOnce(Response.json(true))
      .mockResolvedValueOnce(Response.json([rootPermission]))
      .mockResolvedValueOnce(Response.json(true));
    const alwaysRules = permissionContext({
      method: 'POST',
      path: '/permission/per_root/always-rules',
      body: JSON.stringify(alwaysRulesBody),
      responses: [],
      containerFetch,
    });

    const alwaysRulesResponse = await handlePermission(alwaysRules.context);

    expect(alwaysRulesResponse.status).toBe(200);
    await expect(alwaysRulesResponse.json()).resolves.toBe(true);
    const alwaysRulesRequest = containerFetch.mock.calls[1]?.[0];
    expect(new URL(alwaysRulesRequest.url).pathname).toBe(
      '/kilo-proxy/permission/per_root/always-rules'
    );
    await expect(alwaysRulesRequest.json()).resolves.toEqual(alwaysRulesBody);

    const reply = permissionContext({
      method: 'POST',
      path: '/permission/per_root/reply',
      body: JSON.stringify({ reply: 'always' }),
      responses: [],
      containerFetch,
    });
    const replyResponse = await handlePermission(reply.context);

    expect(replyResponse.status).toBe(200);
    await expect(replyResponse.json()).resolves.toBe(true);
    const replyRequest = containerFetch.mock.calls[3]?.[0];
    expect(new URL(replyRequest.url).pathname).toBe('/kilo-proxy/permission/per_root/reply');
    await expect(replyRequest.json()).resolves.toEqual({ reply: 'always' });
  });

  it('rejects an omitted always-rules body before resolving or mutating a wrapper', async () => {
    const { context, containerFetch } = permissionContext({
      method: 'POST',
      path: '/permission/per_root/always-rules',
      responses: [],
    });

    const response = await handlePermission(context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_INTERACTION_BODY_INVALID',
    });
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('rejects malformed always-rules bodies before resolving or mutating a wrapper', async () => {
    const malformedBodies = [
      { approvedAlways: ['git status', 1] },
      { deniedAlways: 'git push *' },
      { approvedAlways: [], extra: true },
    ];

    for (const body of malformedBodies) {
      const { context, containerFetch } = permissionContext({
        method: 'POST',
        path: '/permission/per_root/always-rules',
        body: JSON.stringify(body),
        responses: [],
      });
      const response = await handlePermission(context);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_INTERACTION_BODY_INVALID',
      });
      expect(containerFetch).not.toHaveBeenCalled();
    }
  });

  it('accepts a native no-underscore ID and uses it for same-root mutation preflight', async () => {
    const nativePermission = { ...rootPermission, id: 'permission-root' };
    const { context, containerFetch } = permissionContext({
      method: 'POST',
      path: '/permission/permission-root/reply',
      body: JSON.stringify({ reply: 'once' }),
      responses: [Response.json([nativePermission]), Response.json(true)],
    });

    const response = await handlePermission(context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toBe(true);
    expect(containerFetch).toHaveBeenCalledTimes(2);
    expect(new URL(containerFetch.mock.calls[1]?.[0].url).pathname).toBe(
      '/kilo-proxy/permission/permission-root/reply'
    );
  });

  it('does not authorize a mutation from a malformed upstream permission ID', async () => {
    const malformedPermission = { ...rootPermission, id: 'wrong-permission-root' };
    const { context, containerFetch } = permissionContext({
      method: 'POST',
      path: '/permission/permission-root/reply',
      body: JSON.stringify({ reply: 'once' }),
      responses: [Response.json([malformedPermission])],
    });

    const response = await handlePermission(context);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: 'KILO_UPSTREAM_RESPONSE_INVALID',
    });
    expect(containerFetch).toHaveBeenCalledTimes(1);
  });

  it('returns facade 404 without mutation for stale, child, and foreign permission IDs', async () => {
    for (const requestID of ['per_stale', 'per_child', 'per_foreign']) {
      const { context, containerFetch } = permissionContext({
        method: 'POST',
        path: `/permission/${requestID}/reply`,
        body: JSON.stringify({ reply: 'reject' }),
        responses: [Response.json([childPermission, foreignPermission])],
      });

      const response = await handlePermission(context);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: 'KILO_INTERACTION_REQUEST_NOT_FOUND',
      });
      expect(containerFetch).toHaveBeenCalledTimes(1);
    }
  });
});
