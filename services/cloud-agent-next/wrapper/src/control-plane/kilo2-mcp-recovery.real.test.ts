import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import { createMessageId } from '../../../src/shared/message-id.js';
import { buildWorktreeKiloEnvironment } from '../control/worktree-runtime.js';
import type { KiloServer } from '../kilo-server-auth.js';
import { createKilo2EventFeed } from './kilo2-event-feed.js';
import { createKiloRuntime, isProxyHandleToken } from './kilo-runtime.js';
import { createKilo2Api } from './kilo2-api.js';
import type { KiloFeedEvent } from './kilo-event-feed.js';

const binary = process.env.KILO2_BINARY;
const suite = binary ? describe : describe.skip;

suite('real Kilo v2 workspace MCP recovery', () => {
  it('restores child-session tools for a sibling after a failed refresh of an unchanged proxy handle', async () => {
    if (!binary || process.env.KILO_RUNTIME_HARNESS !== 'kilo2') {
      throw new Error('Run with KILO2_BINARY and KILO_RUNTIME_HARNESS=kilo2');
    }
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'kilo2-mcp-')));
    const directory = path.join(root, 'workspace');
    const requests: string[] = [];
    let mcpAvailable = false;
    let mcpRequests = 0;
    let discoveryRequested = false;
    const fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/mcp') {
          mcpRequests++;
          if (!mcpAvailable) return new Response(null, { status: 503 });
          if (request.method !== 'POST') return new Response(null, { status: 405 });
          const rpc = z
            .object({ id: z.union([z.string(), z.number()]).optional(), method: z.string() })
            .parse(await request.json());
          if (rpc.id === undefined) return new Response(null, { status: 202 });
          return Response.json({
            jsonrpc: '2.0',
            id: rpc.id,
            result:
              rpc.method === 'initialize'
                ? {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'synthetic-child-sessions', version: '1' },
                  }
                : {
                    tools: ['spawn_session', 'search_models'].map(name => ({
                      name,
                      description: `Synthetic ${name}`,
                      inputSchema: { type: 'object', properties: {} },
                    })),
                  },
          });
        }
        if (pathname.endsWith('/models')) {
          return Response.json({
            data: [
              {
                id: 'fake-deterministic',
                name: 'Local MCP recovery contract',
                context_length: 128000,
                max_completion_tokens: 4096,
                isFree: true,
                pricing: { prompt: '0', completion: '0' },
                opencode: { ai_sdk_provider: 'openai-compatible' },
              },
            ],
          });
        }
        if (!pathname.endsWith('/chat/completions')) return Response.json({});
        const body = await request.text();
        requests.push(body);
        const discover = body.includes('"tools":') && !discoveryRequested;
        if (discover) discoveryRequested = true;
        return new Response(
          `data: ${JSON.stringify({
            id: 'synthetic-completion',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fake-deterministic',
            choices: [
              {
                index: 0,
                delta: discover
                  ? {
                      role: 'assistant',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_synthetic_mcp_discovery',
                          type: 'function',
                          function: {
                            name: 'execute',
                            arguments: JSON.stringify({
                              code: 'return search({namespace: "kilo-cloud-agent"});',
                            }),
                          },
                        },
                      ],
                    }
                  : { role: 'assistant', content: 'done' },
                finish_reason: discover ? 'tool_calls' : 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } }
        );
      },
    });
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ aud: 'cloud-agent-next:runtime-credential-proxy', exp: 1_900_000_000 })
    ).toString('base64url');
    const token = `${header}.${payload}.synthetic`;
    expect(isProxyHandleToken(token)).toBe(true);
    const grant = {
      url: `${fake.url.origin}/mcp`,
      token: 'synthetic-workspace-mcp-token',
      expiresAt: 1_900_000_000,
    };
    const baseEnv = buildWorktreeKiloEnvironment(
      directory,
      root,
      {
        scopeId: 'worktree_synthetic',
        token,
        targets: {
          backendBaseUrl: fake.url.origin,
          providerBaseUrl: `${fake.url.origin}/api/openrouter`,
          sessionIngestBaseUrl: fake.url.origin,
        },
      },
      {},
      { PATH: `${path.dirname(binary)}:${process.env.PATH ?? ''}` }
    );
    const env: Record<string, string> = {
      ...baseEnv,
      KILO_DISABLE_MODELS_FETCH: '1',
      KILO_DISABLE_FFF: '1',
    };
    const config = JSON.stringify({
      ...JSON.parse(env.KILO_CONFIG_CONTENT),
      mcp: {
        'kilo-cloud-agent': {
          type: 'remote',
          url: grant.url,
          oauth: false,
          headers: { Authorization: `Bearer ${grant.token}` },
        },
      },
    });
    const events: KiloFeedEvent[] = [];
    let server: KiloServer | undefined;
    const runtime = createKiloRuntime({
      directory,
      env,
      timers: CONTROL_PLANE_TIMERS,
      pidfileDirectory: path.join(root, 'pids'),
      onEvent: event => events.push(event),
      log() {},
      openFeed(source, callbacks) {
        server = source.server;
        return createKilo2EventFeed({ source, ...callbacks });
      },
    });
    const signal = AbortSignal.timeout(60_000);
    try {
      const first = await runtime.ensure();
      await first.open({
        sessionId: `ses_${'a'.repeat(26)}`,
        directory,
        env,
        signal,
        restoreFiles: false,
        onRestore() {},
      });
      await runtime.installCredentials(
        { ...env, KILO_CONFIG_CONTENT: config, OPENCODE_CONFIG_CONTENT: config },
        grant
      );
      expect(mcpRequests).toBeGreaterThan(0);
      expect(await runtime.applyPendingCredentials(() => false)).toBe(false);
      mcpAvailable = true;
      expect(await runtime.applyPendingCredentials(() => true)).toBe(true);
      const sibling = await runtime.ensure();
      expect(sibling).not.toBe(first);
      const sessionId = `ses_${'b'.repeat(26)}`;
      await sibling.open({
        sessionId,
        directory,
        env: runtime.env,
        signal,
        restoreFiles: false,
        onRestore() {},
      });
      await sibling.submit({
        sessionId,
        directory,
        messageId: createMessageId(),
        prompt: 'synthetic-sibling-mcp-probe',
        model: 'fake-deterministic',
        signal,
      });
      while (
        !events.some(
          event => event.type === 'session.turn.close' && event.properties.sessionID === sessionId
        )
      ) {
        signal.throwIfAborted();
        await Bun.sleep(50);
      }
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.turn.close',
          properties: expect.objectContaining({ sessionID: sessionId, reason: 'completed' }),
        })
      );
      const discovery = requests.find(
        request => request.includes('search_models') && request.includes('spawn_session')
      );
      expect(discovery).toBeDefined();
      if (!server) throw new Error('Missing runtime server');
      const servers = await createKilo2Api(server).data(
        `/api/mcp?location[directory]=${encodeURIComponent(directory)}`,
        { signal }
      );
      expect(servers).toContainEqual(
        expect.objectContaining({ name: 'kilo-cloud-agent', status: { status: 'connected' } })
      );
      await runtime.installCredentials(runtime.env, grant);
      expect(await runtime.applyPendingCredentials(() => true)).toBe(false);
      expect(await runtime.ensure()).toBe(sibling);
    } finally {
      await runtime.shutdown();
      await fake.stop(true);
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 90_000);
});
