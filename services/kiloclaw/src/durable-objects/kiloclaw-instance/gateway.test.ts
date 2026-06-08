import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveGatewayToken } from '../../auth/gateway-token';
import { createMutableState } from './state';
import {
  createAgent,
  deleteAgent,
  getAgent,
  getFileTree,
  getGatewayProcessStatus,
  getMorningBriefingStatus,
  listAgents,
  runMorningBriefing,
  updateAgent,
  updateAgentDefaults,
  waitForHealthy,
  writeOpenclawConfigFile,
} from './gateway';
import { GatewayControllerError } from '../gateway-controller-types';

type FetchMock = ReturnType<
  typeof vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>
>;

function getFetchCall(
  fetchMock: FetchMock,
  index = 0
): { input: unknown; init: RequestInit | undefined } {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected fetch call at index ${index}`);
  }

  const input = call[0];
  const rawInit = call[1];
  const init = rawInit && typeof rawInit === 'object' ? rawInit : undefined;
  return { input, init };
}

describe('gateway controller routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes controller RPCs through provider transport headers', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.status = 'running';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          state: 'running',
          pid: 123,
          uptime: 5,
          restarts: 0,
          lastExit: null,
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getGatewayProcessStatus(state, {
      GATEWAY_TOKEN_SECRET: 'gateway-secret',
      FLY_APP_NAME: 'fallback-app',
    } as never);

    const expectedToken = await deriveGatewayToken('sandbox-1', 'gateway-secret');

    expect(result.state).toBe('running');
    const { input, init } = getFetchCall(fetchMock);
    expect(input).toBe('https://test-app.fly.dev/_kilo/gateway/status');
    expect(init).toBeDefined();
    expect(init?.method).toBe('GET');

    const headers = init?.headers;
    expect(headers).toBeDefined();
    expect(headers).toMatchObject({
      Authorization: `Bearer ${expectedToken}`,
      Accept: 'application/json',
      'fly-force-instance-id': 'machine-1',
    });
  });

  it('encodes file tree directory paths in controller requests', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.status = 'running';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tree: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await getFileTree(
      state,
      {
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_APP_NAME: 'fallback-app',
      } as never,
      'workspace/nested config'
    );

    const { input, init } = getFetchCall(fetchMock);
    expect(input).toBe('https://test-app.fly.dev/_kilo/files/tree?path=workspace%2Fnested+config');
    expect(init?.method).toBe('GET');
  });

  it('uses provider routing for health probes', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.status = 'running';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ state: 'running' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await waitForHealthy(state, {
      GATEWAY_TOKEN_SECRET: 'gateway-secret',
      FLY_APP_NAME: 'fallback-app',
    } as never);

    const expectedToken = await deriveGatewayToken('sandbox-1', 'gateway-secret');

    const { input: statusUrl, init: statusInit } = getFetchCall(fetchMock, 0);
    expect(statusUrl).toBe('https://test-app.fly.dev/_kilo/gateway/status');
    expect(statusInit?.headers).toMatchObject({
      Authorization: `Bearer ${expectedToken}`,
      Accept: 'application/json',
      'fly-force-instance-id': 'machine-1',
    });

    const { input: rootUrl, init: rootInit } = getFetchCall(fetchMock, 1);
    expect(rootUrl).toBe('https://test-app.fly.dev/');
    expect(rootInit?.headers).toMatchObject({
      'fly-force-instance-id': 'machine-1',
    });
  });

  it('returns warm-up payload for morning-briefing status when gateway is warming up', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.status = 'running';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Gateway not running' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getMorningBriefingStatus(state, {
      GATEWAY_TOKEN_SECRET: 'gateway-secret',
      FLY_APP_NAME: 'fallback-app',
    } as never);

    expect(result).toEqual({
      ok: true,
      reconcileState: 'in_progress',
      error: 'Gateway warming up, retrying shortly.',
      code: 'gateway_warming_up',
      retryAfterSec: 2,
    });
  });

  it('does not mask 401 auth failures as warm-up for morning-briefing status', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.status = 'running';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getMorningBriefingStatus(state, {
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_APP_NAME: 'fallback-app',
      } as never)
    ).rejects.toBeInstanceOf(GatewayControllerError);
  });

  it('accepts run response with delivery metadata', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.status = 'running';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          date: '2026-04-24',
          filePath: '/tmp/morning-briefing/2026-04-24.md',
          failures: [],
          delivery: [
            { channel: 'telegram', status: 'sent', target: '-100123' },
            { channel: 'discord', status: 'skipped', reason: 'ambiguous_target' },
          ],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

    const result = await runMorningBriefing(state, {
      GATEWAY_TOKEN_SECRET: 'gateway-secret',
      FLY_APP_NAME: 'fallback-app',
    } as never);

    expect(result).toMatchObject({
      ok: true,
      date: '2026-04-24',
      delivery: [
        { channel: 'telegram', status: 'sent', target: '-100123' },
        { channel: 'discord', status: 'skipped', reason: 'ambiguous_target' },
      ],
    });
    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
  });

  it('forwards validation-aware file writes and parses warnings', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.status = 'running';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          outcome: 'openclaw-validation-warning',
          valid: false,
          reason: 'invalid',
          issues: [{ path: 'gateway.mode', message: 'Expected local' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await writeOpenclawConfigFile(
      state,
      { GATEWAY_TOKEN_SECRET: 'gateway-secret', FLY_APP_NAME: 'fallback-app' } as never,
      '{"gateway":{"mode":"remote"}}',
      'etag-1',
      'warn-before-write'
    );

    expect(result).toMatchObject({ outcome: 'openclaw-validation-warning', reason: 'invalid' });
    const { init } = getFetchCall(fetchMock);
    if (typeof init?.body !== 'string') {
      throw new Error('Expected JSON string request body');
    }
    expect(JSON.parse(init.body)).toEqual({
      content: '{"gateway":{"mode":"remote"}}',
      etag: 'etag-1',
      mode: 'warn-before-write',
    });
  });

  it('fails controller RPCs before fetching when instance state is not running', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.status = 'stopped';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getGatewayProcessStatus(state, {
        GATEWAY_TOKEN_SECRET: 'gateway-secret',
        FLY_APP_NAME: 'fallback-app',
      } as never)
    ).rejects.toMatchObject({ status: 409, message: 'Instance is not running' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns warm-up payload for morning-briefing status when instance is stopped', async () => {
    const state = createMutableState();
    state.provider = 'fly';
    state.status = 'stopped';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';

    const fetchMock: FetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await getMorningBriefingStatus(state, {
      GATEWAY_TOKEN_SECRET: 'gateway-secret',
      FLY_APP_NAME: 'fallback-app',
    } as never);

    expect(result).toEqual({
      ok: true,
      reconcileState: 'in_progress',
      error: 'Gateway warming up, retrying shortly.',
      code: 'gateway_warming_up',
      retryAfterSec: 2,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('agent config mutation timeouts', () => {
  // The controller serializes every agent mutation (CLI create/delete AND native
  // update/update-defaults) through one per-config queue, and CLI ops have their
  // own 30s timeout. If the outer gateway request used the default 30s it could
  // abort before the controller reports its typed outcome, leaving retries with
  // ambiguous state. These mutations must use a longer timeout; reads must not.
  const AGENT_MUTATION_TIMEOUT_MS = 180_000;
  const DEFAULT_TIMEOUT_MS = 30_000;

  const ENV = {
    GATEWAY_TOKEN_SECRET: 'gateway-secret',
    FLY_APP_NAME: 'fallback-app',
  } as never;

  function runningState() {
    const state = createMutableState();
    state.provider = 'fly';
    state.status = 'running';
    state.sandboxId = 'sandbox-1';
    state.flyAppName = 'test-app';
    state.flyMachineId = 'machine-1';
    return state;
  }

  function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Version payload consumed by the capability gate (requireControllerCapability).
  function versionResponse(capabilities: string[]) {
    return jsonResponse({ version: '1', commit: 'abc', capabilities });
  }

  const AGENT_SUMMARY = {
    id: 'work',
    name: 'Work',
    configured: true,
    workspace: '/workspace/work',
    agentDir: '/state/work',
    model: { primary: null, fallbacks: [], source: null },
    rawModel: null,
    settings: {
      thinkingDefault: null,
      verboseDefault: null,
      reasoningDefault: null,
      fastModeDefault: null,
    },
  };
  const DEFAULTS_SUMMARY = {
    model: null,
    settings: {
      thinkingDefault: null,
      verboseDefault: null,
      reasoningDefault: null,
      fastModeDefault: null,
    },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the long mutation timeout for createAgent', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce(versionResponse(['config.agents.create.basic.cli']))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          etag: 'etag-1',
          agent: AGENT_SUMMARY,
          created: {
            agentId: 'work',
            name: 'Work',
            workspace: '/workspace/work',
            agentDir: '/state/work',
          },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await createAgent(runningState(), ENV, { name: 'Work', workspace: '/workspace/work' });

    expect(timeoutSpy).toHaveBeenCalledWith(AGENT_MUTATION_TIMEOUT_MS);
  });

  it('uses the long mutation timeout for deleteAgent', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce(versionResponse(['config.agents.delete.cli']))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          filesystemDisposition: 'unverified',
          agentId: 'work',
          workspace: '/workspace/work',
          agentDir: '/state/work',
          sessionsDir: '/state/work/sessions',
          removedBindings: 0,
          removedAllow: 0,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await deleteAgent(runningState(), ENV, 'work');

    expect(timeoutSpy).toHaveBeenCalledWith(AGENT_MUTATION_TIMEOUT_MS);
  });

  it('uses the long mutation timeout for native updateAgent / updateAgentDefaults', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce(versionResponse(['config.agents.update']))
      .mockResolvedValueOnce(jsonResponse({ ok: true, etag: 'etag-1', agent: AGENT_SUMMARY }))
      .mockResolvedValueOnce(versionResponse(['config.agent-defaults.update']))
      .mockResolvedValueOnce(
        jsonResponse({ ok: true, etag: 'etag-2', defaults: DEFAULTS_SUMMARY })
      );
    vi.stubGlobal('fetch', fetchMock);

    await updateAgent(runningState(), ENV, 'work', { set: { thinkingDefault: 'high' } });
    await updateAgentDefaults(runningState(), ENV, { set: { thinkingDefault: 'low' } });

    expect(timeoutSpy).toHaveBeenCalledWith(AGENT_MUTATION_TIMEOUT_MS);
  });

  it('keeps the default timeout for reads (listAgents)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce(versionResponse(['config.agents.read']))
      .mockResolvedValueOnce(
        jsonResponse({ etag: 'etag-1', defaults: DEFAULTS_SUMMARY, agents: [AGENT_SUMMARY] })
      );
    vi.stubGlobal('fetch', fetchMock);

    await listAgents(runningState(), ENV);

    expect(timeoutSpy).not.toHaveBeenCalledWith(AGENT_MUTATION_TIMEOUT_MS);
    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS);
  });

  // Typed errors must be RETURNED as an envelope (not thrown), because .status/.code
  // are stripped crossing the DO RPC boundary. These assert the real conversion.

  it('returns a capability_unavailable envelope when the controller lacks the capability', async () => {
    // Version response advertises no capabilities → requireControllerCapability fails closed.
    const fetchMock: FetchMock = vi.fn().mockResolvedValueOnce(versionResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getAgent(runningState(), ENV, 'work');

    expect(result).toEqual({
      agentError: {
        status: 501,
        code: 'capability_unavailable',
        message: expect.stringContaining('config.agents.read'),
      },
    });
    // Only the version probe ran — the agent endpoint was never reached.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns an agent_not_found envelope when the controller 404s', async () => {
    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce(versionResponse(['config.agents.read']))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'agent_not_found', error: 'Agent not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getAgent(runningState(), ENV, 'ghost');

    expect(result).toEqual({
      agentError: { status: 404, code: 'agent_not_found', message: 'Agent not found' },
    });
  });

  it('returns a config_etag_conflict envelope when an update 409s', async () => {
    const fetchMock: FetchMock = vi
      .fn()
      .mockResolvedValueOnce(versionResponse(['config.agents.update']))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'config_etag_conflict', error: 'Config changed' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateAgent(runningState(), ENV, 'work', {
      etag: 'stale',
      set: { thinkingDefault: 'high' },
    });

    expect(result).toEqual({
      agentError: { status: 409, code: 'config_etag_conflict', message: 'Config changed' },
    });
  });
});
