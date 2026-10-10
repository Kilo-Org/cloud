import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKiloClient } from '@kilocode/sdk/v2/client';
import { createKiloClient as createLegacyKiloClient } from '@kilocode/sdk';
import { createWrapperKiloClient } from '../kilo-api.js';
import { unfilteredKiloEvents } from '../control/feed.js';

type ToolCall = { name: string; arguments: Record<string, unknown> };
export type ModelReply = { text?: string; tools?: ToolCall[]; status?: number };

/** Isolated real-binary fixture: no inherited credentials or user configuration. */
export async function activityFixture(
  binary: string,
  options: {
    subagentPermission?: Record<string, 'allow' | 'ask' | 'deny'>;
    modelBaseUrl?: string;
  } = {}
) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'kilo-activity-781-')));
  const directory = path.join(root, 'workspace');
  await fsp.mkdir(directory);
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
  };
  const version = Bun.spawnSync([binary, '--version'], { env });
  if (version.stdout.toString().trim() !== '7.8.1') throw new Error('Expected Kilo 7.8.1');
  let respond: () => Promise<ModelReply> = async () => ({ text: 'done' });
  let requests = 0;
  const fake = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (!new URL(request.url).pathname.endsWith('/chat/completions')) {
        return Response.json({ data: [] });
      }
      requests++;
      await request.arrayBuffer();
      const reply = await respond();
      if (reply.status)
        return Response.json({ error: { message: 'fixture retry' } }, { status: reply.status });
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fake-deterministic',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      const delta = reply.tools
        ? {
            role: 'assistant',
            tool_calls: reply.tools.map((tool, index) => ({
              index,
              id: `call_${requests}_${index}`,
              type: 'function',
              function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
            })),
          }
        : { role: 'assistant', content: reply.text ?? 'done' };
      return new Response(
        chunk(delta, null) + chunk({}, reply.tools ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      );
    },
  });
  const proc = Bun.spawn([binary, 'serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: directory,
    env: {
      ...env,
      KILO_CONFIG_CONTENT: JSON.stringify({
        model: 'contract/fake-deterministic',
        small_model: 'contract/fake-deterministic',
        share: 'disabled',
        permission: { '*': 'allow' },
        agent: {
          title: { disable: true },
          ...(options.subagentPermission
            ? { general: { permission: options.subagentPermission } }
            : {}),
        },
        provider: {
          contract: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Contract Fake',
            options: { baseURL: options.modelBaseUrl ?? `${fake.url}v1`, apiKey: 'local-test' },
            models: {
              'fake-deterministic': { name: 'Fake', limit: { context: 128000, output: 4096 } },
            },
          },
        },
      }),
    },
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(90_000)]);
  let consume: Promise<void> | undefined;
  const events: Array<{ type: string; properties: Record<string, unknown>; directory?: string }> =
    [];
  async function dispose() {
    lifetime.abort();
    proc.kill();
    await proc.exited;
    await fake.stop(true);
    await consume?.catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
  }
  try {
    const reader = proc.stdout.getReader();
    let output = '';
    let url: string | undefined;
    while (!url) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('Kilo startup timed out')), {
            once: true,
          })
        ),
      ]);
      if (next.done) throw new Error('Kilo exited before listening');
      output += new TextDecoder().decode(next.value);
      url = /kilo server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    }
    const client = createKiloClient({ baseUrl: url, directory });
    const stream = await client.global.event({ signal, sseMaxRetryAttempts: 1 });
    consume = (async () => {
      for await (const event of unfilteredKiloEvents(stream.stream)) events.push(event);
    })();
    void consume.catch(() => undefined);
    async function until<T>(
      read: () => T | Promise<T>,
      predicate: (value: T) => boolean,
      label: string
    ): Promise<T> {
      const deadline = Date.now() + 25_000;
      while (true) {
        signal.throwIfAborted();
        const value = await read();
        if (predicate(value)) return value;
        if (Date.now() >= deadline)
          throw new Error(
            `Timed out: ${label}; events=${events
              .map(e => e.type)
              .slice(-25)
              .join(',')}`
          );
        await Bun.sleep(20);
      }
    }
    await until(
      () => events,
      items => items.some(e => e.type === 'server.connected'),
      'feed connection'
    );
    return {
      root,
      directory,
      client,
      wrapper: createWrapperKiloClient(createLegacyKiloClient({ baseUrl: url }), url, directory),
      globalClient: createKiloClient({ baseUrl: url }),
      events,
      signal,
      dispose,
      until,
      get requests() {
        return requests;
      },
      respond(handler: typeof respond) {
        respond = handler;
      },
      async session(dir = directory, parentID?: string) {
        await fsp.mkdir(dir, { recursive: true });
        const result = await client.session.create(
          { directory: dir, parentID, title: 'Activity contract' },
          { signal }
        );
        if (!result.data) throw new Error('Session creation failed');
        return result.data.id;
      },
      async prompt(sessionID: string, text = 'fixture work', dir = directory) {
        const result = await client.session.promptAsync(
          {
            sessionID,
            directory: dir,
            model: { providerID: 'contract', modelID: 'fake-deterministic' },
            parts: [{ type: 'text', text }],
          },
          { signal }
        );
        if (result.error) throw new Error('Prompt admission failed');
      },
      sessionEvents(sessionID: string) {
        return events.filter(event => event.properties.sessionID === sessionID);
      },
      async idle(sessionID: string, dir = directory) {
        await until(
          () => client.session.status({ directory: dir }, { signal }),
          result => !!result.data && !result.data[sessionID],
          'session idle'
        );
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
