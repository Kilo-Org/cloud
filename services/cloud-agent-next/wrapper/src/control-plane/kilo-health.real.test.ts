import { describe, expect, it, spyOn } from 'bun:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk/v2/client';
import { CONTROL_PLANE_TIMERS } from '../../../src/shared/control-plane-timers.js';
import { createKiloEventFeed } from './kilo-event-feed.js';
import { createKiloRuntime } from './kilo-runtime.js';

const binary = process.env.KILO_781_BINARY;
const suite = binary ? describe : describe.skip;

async function waitFor(condition: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Pinned native health condition timed out');
    await Bun.sleep(20);
  }
}

suite('pinned Kilo default health supervision', () => {
  it('responsive pinned Kilo 7.8.1 recovers native SSE silence without restart', async () => {
    if (!binary) throw new Error('KILO_781_BINARY is required');
    expect(Bun.spawnSync([binary, '--version']).stdout.toString().trim()).toBe('7.8.1');
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kilo-health-781-'));
    const release = Promise.withResolvers<void>();
    let modelRequests = 0;
    const fake = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname.endsWith('/chat/completions')) {
          modelRequests++;
          await release.promise;
          return new Response(
            'data: {"id":"fake","object":"chat.completion.chunk","created":1,"model":"fake-deterministic","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":null}]}\n\ndata: {"id":"fake","object":"chat.completion.chunk","created":1,"model":"fake-deterministic","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } }
          );
        }
        return Response.json({ data: [] });
      },
    });
    const config = {
      model: 'contract/fake-deterministic',
      small_model: 'contract/fake-deterministic',
      share: 'disabled',
      agent: { title: { disable: true } },
      provider: {
        contract: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Contract Fake',
          options: { baseURL: `${fake.url}v1`, apiKey: 'local-test' },
          models: {
            'fake-deterministic': { name: 'Fake', limit: { context: 128000, output: 4096 } },
          },
        },
      },
    };
    const env = {
      PATH: `${path.dirname(path.resolve(binary))}:${process.env.PATH ?? ''}`,
      HOME: root,
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_STATE_HOME: path.join(root, 'state'),
      KILO_CONFIG_CONTENT: JSON.stringify(config),
    };
    let suppress = false;
    let opens = 0;
    let dropped = 0;
    let restarts = 0;
    const fetchSpy = spyOn(globalThis, 'fetch');
    const events: { type: string; at: number }[] = [];
    const logs: string[] = [];
    const runtime = createKiloRuntime({
      directory: root,
      env,
      timers: CONTROL_PLANE_TIMERS,
      pidfileDirectory: path.join(root, 'pids'),
      log: line => logs.push(line),
      onRestart: () => {
        restarts++;
      },
      openFeed(source, callbacks) {
        opens++;
        if (opens > 1) suppress = false;
        return createKiloEventFeed({
          source,
          signal: callbacks.signal,
          log: line => logs.push(line),
          onFailure: callbacks.onFailure,
          onEvent(event) {
            if (suppress) {
              dropped++;
              return;
            }
            events.push({ type: event.type, at: Date.now() });
            callbacks.onEvent(event);
          },
        });
      },
    });
    try {
      const wrapper = await runtime.ensure();
      const client = createKiloClient({ baseUrl: wrapper.serverUrl, directory: root });
      const before = await client.global.health({ signal: AbortSignal.timeout(5000) });
      expect(before.data?.healthy).toBe(true);
      expect(before.data?.version).toBe('7.8.1');
      const created = await client.session.create({
        directory: root,
        title: 'Native silence health regression',
      });
      if (!created.data?.id) throw new Error('Native session prerequisite failed');
      const sessionID = created.data.id;
      const submitted = await client.session.promptAsync({
        sessionID,
        directory: root,
        model: { providerID: 'contract', modelID: 'fake-deterministic' },
        parts: [{ type: 'text', text: 'native-health-single-submit' }],
      });
      expect(submitted.error).toBeUndefined();
      await waitFor(() => modelRequests === 1, 30000);
      await waitFor(() => events.some(event => event.type === 'server.heartbeat'), 16000);
      const candidates = Bun.spawnSync(['pgrep', '-f', 'kilo.*serve --hostname=127.0.0.1 --port=0'])
        .stdout.toString()
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const owned = candidates.filter(pid =>
        Bun.spawnSync(['lsof', '-a', '-p', pid, '-d', 'cwd', '-Fn'])
          .stdout.toString()
          .includes(root)
      );
      const parents = owned.map(pid =>
        Number(Bun.spawnSync(['ps', '-p', pid, '-o', 'ppid=']).stdout.toString().trim())
      );
      const native = owned.filter(pid => !parents.includes(Number(pid)));
      expect(native).toHaveLength(1);
      const pid = Number(native[0]);
      process.kill(pid, 0);
      const lastActivity = events.filter(event => event.type !== 'server.connected').at(-1)?.at;
      suppress = true;
      await waitFor(
        () => opens === 2 && events.filter(event => event.type === 'server.connected').length === 2,
        42000
      );
      const reconnectAt = events.filter(event => event.type === 'server.connected').at(-1)?.at;
      if (reconnectAt === undefined) throw new Error('Reconnect handshake not observed');
      await waitFor(
        () => events.some(event => event.type === 'server.heartbeat' && event.at >= reconnectAt),
        12000
      );
      const heartbeatAt = events.find(
        event => event.type === 'server.heartbeat' && event.at >= reconnectAt
      )?.at;
      expect(runtime.isSuspected()).toBe(false);
      process.kill(pid, 0);
      const healthRequests = fetchSpy.mock.calls.filter(
        ([input]) => input instanceof Request && new URL(input.url).pathname === '/global/health'
      ).length;
      expect(healthRequests).toBe(2);
      release.resolve();
      const deadline = Date.now() + 15000;
      let transcript = await client.session.messages({ sessionID, directory: root });
      while (
        !transcript.data?.some(
          message => message.info.role === 'assistant' && message.info.time.completed
        )
      ) {
        if (Date.now() > deadline) throw new Error('Native completion deadline expired');
        await Bun.sleep(50);
        transcript = await client.session.messages({ sessionID, directory: root });
      }
      const users = transcript.data.filter(message => message.info.role === 'user');
      expect(users).toHaveLength(1);
      expect(
        users
          .flatMap(message => message.parts)
          .filter(part => part.type === 'text' && part.text === 'native-health-single-submit')
      ).toHaveLength(1);
      expect(modelRequests).toBe(1);
      expect(restarts).toBe(0);
      expect(logs.filter(line => line.includes(' kilo restarting '))).toEqual([]);
      process.kill(pid, 0);
      console.log(
        JSON.stringify({
          fixture: 'real native SSE silence',
          version: before.data?.version,
          pidBefore: pid,
          pidAfter: pid,
          lastActivity,
          reconnectAt,
          heartbeatAt,
          healthRequests,
          watchdogRequests: healthRequests - 1,
          opens,
          dropped,
          restarts,
          modelRequests,
          nativeUserMessages: users.length,
          completed: true,
        })
      );
    } finally {
      release.resolve();
      await runtime.shutdown();
      fetchSpy.mockRestore();
      await fake.stop(true);
      await fsp.rm(root, { recursive: true, force: true });
    }
  }, 105000);
});
