import { describe, expect, it } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { PINNED_CLIS } from '../../../scripts/runtime-cli-artifact.js';
import { createMessageId } from '../../../src/shared/message-id.js';
import { createKiloServerCredential } from '../kilo-server-auth.js';
import { createKilo2Api, kilo2SessionPath } from './kilo2-api.js';

const binary = process.env.KILO2_BINARY;
const suite = binary ? describe : describe.skip;
const wakeupPrompt = 'Synthetic follow-up for the wakeup contract';
const schedule = { name: 'schedule_wakeup', arguments: { delay: '10s', prompt: wakeupPrompt } };
const repositoryInstruction = 'Synthetic proof that Kilo loaded the repository configuration';
const modelId = 'fake-deterministic';
const model = { providerID: 'kilo', id: modelId };
const requestSchema = z.object({
  messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
  tools: z
    .array(
      z.object({
        function: z.object({
          name: z.string(),
          description: z.string().optional(),
          parameters: z.object({ properties: z.record(z.string(), z.unknown()).optional() }),
        }),
      })
    )
    .optional(),
});
const recordsSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('setup'), value: z.boolean() }),
  z.object({
    kind: z.literal('call'),
    value: z.object({ name: z.string(), sessionID: z.string(), args: z.unknown() }),
  }),
  z.object({
    kind: z.literal('goal'),
    value: z.object({
      sessionID: z.string(),
      status: z.string().nullable(),
      reason: z.string().optional(),
    }),
  }),
]);
type ModelRequest = z.infer<typeof requestSchema>;
type ToolCall = { name: string; arguments: Record<string, unknown> };
type ModelReply = ToolCall | string | undefined;

async function fixture(
  executable: string,
  options: { repositoryRemoval?: boolean; production?: boolean } = {}
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo2-wakeup-contract-'));
  const directory = path.join(root, 'workspace');
  const plugin = path.join(root, 'cloud-wakeup-contract');
  const recordPath = path.join(root, 'records.jsonl');
  await fs.mkdir(directory);
  await fs.cp(new URL('./fixtures/cloud-wakeup-plugin', import.meta.url), plugin, {
    recursive: true,
  });
  await fs.writeFile(recordPath, '');
  const productionRequests: unknown[] = [];
  const wakeupEndpoint = options.production
    ? Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        async fetch(request) {
          productionRequests.push(await request.json());
          return Response.json({
            ok: true,
            wakeup: {
              id: 'wku_contract',
              dueAt: Date.now() + 20_000,
              prompt: 'contract resume',
              mode: 'stay-awake',
              state: 'pending',
              failure: null,
            },
          });
        },
      })
    : undefined;
  if (wakeupEndpoint)
    await fs.copyFile(
      new URL('./cloud-wakeup-plugin.mjs', import.meta.url),
      path.join(plugin, 'server.mjs')
    );
  if (options.repositoryRemoval) {
    await fs.writeFile(path.join(directory, 'contract.md'), repositoryInstruction);
    await fs.mkdir(path.join(directory, '.kilo'));
    await fs.writeFile(
      path.join(directory, '.kilo', 'kilo.json'),
      JSON.stringify({ plugins: ['-cloud-wakeup-contract'], instructions: ['contract.md'] })
    );
  }

  const requests: ModelRequest[] = [];
  let reply: (request: ModelRequest, index: number) => ModelReply = () => undefined;
  const fake = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith('/models')) {
        return Response.json({
          data: [
            {
              id: modelId,
              name: 'Cloud wakeup contract fake',
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
      const body = requestSchema.parse(await request.json());
      const index = requests.push(body) - 1;
      const result = reply(body, index);
      const tool = typeof result === 'object' ? result : undefined;
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${index}`,
                type: 'function',
                function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
              },
            ],
          }
        : { role: 'assistant', content: result ?? 'Fixture turn complete' };
      const chunk = (value: unknown, reason: string | null) =>
        `data: ${JSON.stringify({
          id: `fixture_${index}`,
          object: 'chat.completion.chunk',
          created: 1,
          model: modelId,
          choices: [{ index: 0, delta: value, finish_reason: reason }],
        })}\n\n`;
      return new Response(
        chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      );
    },
  });
  const credential = createKiloServerCredential('opencode');
  const env = {
    ...credential.env,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
    KILO_API_KEY: 'local-test',
    KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: 'local-test' } }),
    KILO_API_URL: fake.url.origin,
    KILO_AI_GATEWAY_URL: `${fake.url.origin}/v1`,
    KILO_DISABLE_MODELS_FETCH: '1',
    KILO_DISABLE_FFF: '1',
    KILO_USE_RELEASE_CONFIG: '1',
    KILO_CONFIG_CONTENT: JSON.stringify({
      model: `kilo/${modelId}`,
      agents: {
        title: { disabled: true },
        wakeup_child: { mode: 'subagent', system: 'Synthetic child wakeup contract' },
      },
      permissions: [
        { action: '*', resource: '*', effect: 'allow' },
        ...(wakeupEndpoint
          ? [
              { action: 'schedule_wakeup', resource: '*', effect: 'deny' },
              { action: 'cancel_wakeup', resource: '*', effect: 'deny' },
            ]
          : []),
      ],
      plugins: [
        {
          package: pathToFileURL(plugin).href,
          options: wakeupEndpoint
            ? { url: wakeupEndpoint.url.href, secret: 'fixture' }
            : { recordPath },
        },
      ],
      snapshots: false,
    }),
  };
  const proc = Bun.spawn([executable, 'serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd: directory,
    env,
    stdout: 'pipe',
    stderr: 'ignore',
  });
  const startup = AbortSignal.timeout(10_000);
  async function dispose() {
    proc.kill();
    await proc.exited;
    await fake.stop(true);
    await wakeupEndpoint?.stop(true);
    await fs.rm(root, { recursive: true, force: true });
  }
  try {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    let output = '';
    let url: string | undefined;
    const timeout = new Promise<never>((_, reject) =>
      startup.addEventListener('abort', () => reject(new Error('Kilo v2 startup timed out')), {
        once: true,
      })
    );
    while (!url) {
      const next = await Promise.race([reader.read(), timeout]);
      if (next.done) throw new Error('Kilo v2 exited before listening');
      output += decoder.decode(next.value, { stream: true });
      url = /server listening on (http:\/\/127\.0\.0\.1:\d+)\r?\n/.exec(output)?.[1];
    }
    const api = createKilo2Api({ url, authorization: credential.authorization });
    return {
      api,
      directory,
      requests,
      productionRequests,
      dispose,
      respond(handler: typeof reply) {
        reply = handler;
      },
      async records() {
        return (await fs.readFile(recordPath, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map(line => recordsSchema.parse(JSON.parse(line)));
      },
      async session() {
        return z.object({ id: z.string() }).parse(
          await api.data('/api/session', {
            method: 'POST',
            body: { location: { directory }, model, title: 'Cloud wakeup contract' },
          })
        ).id;
      },
      async prompt(sessionID: string, text: string) {
        await api.request(`${kilo2SessionPath(sessionID)}/prompt`, {
          method: 'POST',
          body: { id: createMessageId(), text },
        });
      },
      async waitForIdle(sessionID: string) {
        await api.request(`/api/experimental/session/${sessionID}/wait`, { method: 'POST' });
      },
      command(sessionID: string, name: string, text: string) {
        return api.request(`${kilo2SessionPath(sessionID)}/command`, {
          method: 'POST',
          body: { name, text },
        });
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function contract(
  name: string,
  run: (f: Fixture) => Promise<void>,
  options?: Parameters<typeof fixture>[1]
) {
  it(
    name,
    async () => {
      if (!binary) throw new Error('KILO2_BINARY is required');
      expect(Bun.spawnSync([binary, '--version'], { env: {} }).stdout.toString().trim()).toBe(
        PINNED_CLIS.kilo2.reportedVersion
      );
      const f = await fixture(binary, options);
      try {
        await run(f);
      } finally {
        await f.dispose();
      }
    },
    55_000
  );
}

function expectReplacement(request: ModelRequest | undefined) {
  for (const [name, fields] of [
    ['schedule_wakeup', ['delay', 'prompt']],
    ['cancel_wakeup', ['id']],
  ] as const) {
    const tools = request?.tools?.filter(tool => tool.function.name === name) ?? [];
    expect(tools.map(tool => tool.function.description)).toEqual([
      `Cloud contract replacement for ${name}`,
    ]);
    expect(Object.keys(tools[0]?.function.parameters.properties ?? {}).sort()).toEqual([...fields]);
  }
}

suite('pinned Kilo v2 Cloud wakeup plugin contract', () => {
  contract(
    'routes the production tool while native wakeup permission is denied',
    async f => {
      const sessionID = await f.session();
      f.respond((_, index) => (index === 0 ? schedule : undefined));
      await f.prompt(sessionID, 'Schedule the Cloud wakeup');
      await f.waitForIdle(sessionID);
      expect(f.productionRequests).toEqual([
        {
          sessionID,
          command: {
            action: 'schedule',
            callId: expect.stringMatching(/^(?!undefined:undefined$).+:.+$/),
            ...schedule.arguments,
          },
        },
      ]);
      expect(JSON.stringify(f.requests[1]?.messages)).toContain('Scheduled wakeup wku_contract');
    },
    { production: true }
  );

  contract(
    'replaces native tools, receives the chat ID, and does not arm a native timer',
    async f => {
      const sessionID = await f.session();
      f.respond((_, index) => (index === 0 ? schedule : undefined));
      await f.prompt(sessionID, 'Schedule the fixture wakeup');
      await f.waitForIdle(sessionID);

      expectReplacement(f.requests[0]);
      const calls = (await f.records()).filter(record => record.kind === 'call');
      expect(calls.map(call => call.value)).toEqual([
        { name: schedule.name, sessionID, args: schedule.arguments },
      ]);
      expect(JSON.stringify(f.requests[1]?.messages)).toContain('Fixture executed schedule_wakeup');
      const requestCount = f.requests.length;
      await Bun.sleep(20_000);
      expect(f.requests).toHaveLength(requestCount);
    }
  );

  contract('includes the pending instruction entry on the next user turn', async f => {
    const sessionID = await f.session();
    f.respond((_, index) => (index === 0 ? schedule : undefined));
    await f.prompt(sessionID, 'Schedule the fixture wakeup');
    await f.waitForIdle(sessionID);
    const entries = `/api/experimental/session/${sessionID}/instructions/entries`;
    expect(await f.api.data(entries)).toContainEqual({
      key: 'cloud-wakeup',
      value: `Pending cloud-wakeup. Mode: stay awake. Prompt: ${wakeupPrompt}`,
    });

    const requestOffset = f.requests.length;
    await f.prompt(sessionID, 'Send a new fixture user prompt');
    await f.waitForIdle(sessionID);
    const messages = f.requests[requestOffset]?.messages;
    expect(
      messages?.some(item =>
        JSON.stringify(item.content).includes(
          `Pending cloud-wakeup. Mode: stay awake. Prompt: ${wakeupPrompt}`
        )
      )
    ).toBe(true);
  });

  contract('refuses a wakeup from a subagent', async f => {
    let delegated = false;
    let childCalled = false;
    f.respond(request => {
      if (!delegated) {
        delegated = true;
        return {
          name: 'subagent',
          arguments: {
            agent: 'wakeup_child',
            description: 'Test the root restriction',
            prompt: 'Try scheduling the wakeup fixture',
            background: false,
          },
        };
      }
      if (
        !childCalled &&
        JSON.stringify(request.messages).includes('Synthetic child wakeup contract')
      ) {
        childCalled = true;
        return schedule;
      }
      return undefined;
    });
    const sessionID = await f.session();
    await f.prompt(sessionID, 'Delegate the fixture wakeup test');
    await f.waitForIdle(sessionID);

    const calls = (await f.records()).filter(record => record.kind === 'call');
    expect(calls).toHaveLength(1);
    const childID = calls[0]?.value.sessionID;
    expect(childID).toBeString();
    expect(childID).not.toBe(sessionID);
    expect(await f.api.data(kilo2SessionPath(String(childID)))).toMatchObject({
      parentID: sessionID,
    });
    expect(JSON.stringify(f.requests)).toContain('Cloud wakeups require a root chat');
  });

  contract(
    'cannot be removed by a lower-priority repository plugin removal',
    async f => {
      const sessionID = await f.session();
      await f.prompt(sessionID, 'Read the fixture tool list');
      await f.waitForIdle(sessionID);
      expect(JSON.stringify(f.requests[0]?.messages).includes(repositoryInstruction)).toBe(true);
      expectReplacement(f.requests[0]);
    },
    { repositoryRemoval: true }
  );

  contract('records goal behavior after scheduling and after /goal clear', async f => {
    let called = false;
    let reviews = 0;
    f.respond(request => {
      if (JSON.stringify(request.messages).includes('No background shells are running.')) {
        reviews++;
        return JSON.stringify({ verdict: 'wait', reason: 'Wait for the Cloud wakeup' });
      }
      if (!called && request.tools?.some(tool => tool.function.name === 'schedule_wakeup')) {
        called = true;
        return schedule;
      }
      return undefined;
    });
    const sessionID = await f.session();
    await f.command(sessionID, 'goal', 'Wait for a synthetic CI result');
    await f.waitForIdle(sessionID);
    const beforeClear = await f.records();
    expect(
      beforeClear.filter(record => record.kind === 'call').map(record => record.value)
    ).toEqual([{ name: schedule.name, sessionID, args: schedule.arguments }]);
    await f.command(sessionID, 'goal', 'clear');
    await f.waitForIdle(sessionID);
    const deadline = Date.now() + 1000;
    const goalChanges = async () =>
      (await f.records()).flatMap(record =>
        record.kind === 'goal' && record.value.sessionID === sessionID
          ? [{ status: record.value.status, reason: record.value.reason }]
          : []
      );
    let changes = await goalChanges();
    while (changes.at(-1)?.status !== null && Date.now() < deadline) {
      await Bun.sleep(20);
      changes = await goalChanges();
    }
    console.info('Cloud wakeup goal contract:', { reviews, changes });
  });
});
