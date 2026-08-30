/* eslint-disable import/no-nodejs-modules, import/max-dependencies, max-lines, no-await-in-loop, jest/prefer-each, jest/no-conditional-in-test, jest/no-conditional-expect, jest/max-expects, promise/avoid-new, init-declarations, typescript/consistent-type-definitions -- Deferred resources have explicit cleanup; live success always uses real CLI tools. */
import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  browserJobIdSchema,
  browserProviderDescriptorSchema,
  browserProviderIdSchema,
  browserProviderInboundMessageSchema,
  browserTaskArgumentsSchema,
  browserTaskIdSchema,
} from '@kilocode/cloud-agent-sdk/schemas';
import type {
  BrowserProviderInboundMessage,
  BrowserTaskArguments,
} from '@kilocode/cloud-agent-sdk/schemas';
import { conversationEventsSchema } from '../../entrypoints/sidepanel/agent-conversation-schemas';
import { launchExtensionContext, readExtensionLocalStorage } from './extension-context-fixture';
import { signInWithLocalDeviceAuth } from './local-device-auth-helpers';
import { selectModelById } from './model-picker-e2e-helpers';

// Preparation belongs to the orchestrator: inspect dev:status; start only missing nextjs and
// Cloudflare-session-ingest with KILO_PORT_OFFSET=auto; inspect dev:seed without arguments;
// Seed one account and credits; privately supply its token; build the unpacked local artifact.
// Run this file explicitly with EXTENSION_LOCAL_BACKEND_E2E=1. Discovery is not live proof.
test.skip(
  process.env['EXTENSION_LOCAL_BACKEND_E2E'] !== '1',
  'requires the prepared local CLI, extension, and relay stack'
);
test.use({ screenshot: 'off', trace: 'off', video: 'off' });
test.setTimeout(15 * 60_000);

const cloudRoot = resolve(import.meta.dirname, '../../../..');
const model = 'deepseek/deepseek-v4-flash-0731';
const cliModel = { modelID: model, providerID: 'kilo' };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'timed_out']);
const required = (name: string): string =>
  z.string().min(1, `Prepare ${name} before live acceptance.`).parse(process.env[name]);
const portSchema = z.coerce.number().int().min(1).max(65_535);
const statusSchema = z.object({
  services: z.array(z.object({ name: z.string(), port: portSchema, status: z.string() })),
});
const remoteSchema = z.object({ connected: z.boolean(), enabled: z.boolean() });
const sessionSchema = z.object({ id: z.string().startsWith('ses_') });
const permissionSchema = z.array(
  z.object({
    id: z.string(),
    patterns: z.array(z.string()),
    permission: z.string(),
    sessionID: z.string(),
  })
);
const messagesSchema = z.array(
  z.object({ info: z.object({ id: z.string() }), parts: z.array(z.unknown()) })
);
const toolPartSchema = z.object({
  id: z.string(),
  state: z.object({ input: z.unknown(), output: z.string().optional(), status: z.string() }),
  tool: z.literal('browser_task'),
  type: z.literal('tool'),
});
const outputFields = {
  browser_task_id: browserTaskIdSchema.optional(),
  effectsUncertain: z.boolean(),
  evidence: z.array(
    z.object({
      text: z.string().optional(),
      title: z.string().optional(),
      url: z.string().optional(),
    })
  ),
  invocation_id: z.string().optional(),
  job_id: browserJobIdSchema.optional(),
  provider_id: browserProviderIdSchema.optional(),
  reason: z.string(),
  status: z.string(),
  summary: z.string(),
};
const outputSchema = z.object({
  ...outputFields,
  jobs: z.array(z.object(outputFields)).optional(),
  providers: z.array(browserProviderDescriptorSchema).optional(),
});
const gatewayRequestSchema = z.object({ messages: z.array(z.unknown()), model: z.string() });
const replayMessageSchema = z.object({
  content: z.unknown().optional(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({ id: z.string() })).optional(),
});
const toolProjectionSchema = z.object({
  effectsUncertain: z.boolean().optional(),
  error: z.string().optional(),
  ok: z.boolean(),
  value: z.unknown().optional(),
});
const browserHistorySchema = z.object({
  histories: z.array(
    z.object({ browserTaskId: browserTaskIdSchema, events: conversationEventsSchema })
  ),
});
const modelCatalogSchema = z.object({ data: z.array(z.object({ id: z.string() })) });
const proxyStatsSchema = z.object({
  droppedReplies: z.number(),
  invocations: z.number(),
  lastInvocationId: z.string().optional(),
  probe: z.object({ code: z.string().optional(), kind: z.string() }).optional(),
});
type ProbeTarget = { parent: string; provider: string; task: string };
type Output = z.infer<typeof outputSchema>;
type Delivery = Extract<BrowserProviderInboundMessage, { type: 'provider_job' }>;

type Evidence = {
  checks: string[];
  clock: 'production deadlines';
  model: string;
  scenarios: string[];
  screenshots: string[];
};
const readJson = async <Value>(
  url: URL,
  schema: z.ZodType<Value>,
  init: RequestInit = {}
): Promise<Value> => {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  const response = await fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url.pathname}; no response body was logged.`);
  }
  if (response.headers.get('content-type')?.includes('application/json') !== true) {
    throw new Error(`Expected JSON Content-Type from ${url.pathname}.`);
  }
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`Invalid JSON structure from ${url.pathname}.`);
  }
  return parsed.data;
};
const freePort = (): number =>
  portSchema.parse(
    execFileSync(join(required('KILO_WORKFLOW'), 'free-port.sh'), { encoding: 'utf8' }).trim()
  );
const stopChild = async (
  child: ChildProcess,
  signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, 'exit');
  const force = setTimeout(() => {
    child.kill('SIGKILL');
  }, 5000);
  child.kill(signal);
  try {
    await exited;
  } finally {
    clearTimeout(force);
  }
};

// A transparent test-only fault proxy. Bun owns WebSocket framing. The real relay still
// Authenticates, negotiates, deduplicates, queues, authorizes, and persists every browser job.
// Never return or log the captured invocation: it contains the parent's private proof.
const faultProxySource = `
const state = { dropBefore: false, dropReplies: false, droppedReplies: 0, invocations: 0 };
const sockets = new Set();
const owners = new Map();
const probes = new Map();
let invocation;
let invocationSocket;
const stats = probe => ({ droppedReplies: state.droppedReplies, invocations: state.invocations, lastInvocationId: invocation?.invocationId, ...(probe ? { probe } : {}) });
Bun.serve({
  hostname: '127.0.0.1', port: Number(process.env.PORT),
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/control') {
      if (request.headers.get('x-kilo-e2e-control') !== process.env.CONTROL_KEY) return new Response(null, { status: 403 });
      const command = await request.json();
      const { operation } = command;
      if (operation.startsWith('probe-')) {
        const authority = owners.get(command.parent);
        if (!authority || authority.remote.readyState !== WebSocket.OPEN) return new Response(null, { status: 409 });
        const requestId = crypto.randomUUID();
        const action = operation.slice(6);
        const nonce = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
        const reply = Promise.withResolvers();
        const timer = setTimeout(() => reply.resolve({ kind: 'timeout' }), 10000);
        probes.set(requestId, reply.resolve);
        authority.remote.send(JSON.stringify({ type: 'browser_request', requestId, operation: action, owner: authority.owner, browserTaskId: command.task, ...(action === 'invoke' ? { providerId: command.provider, goal: 'This foreign continuation must be denied.', invocationId: 'b1.' + Date.now() + '.' + nonce } : {}) }));
        try {
          const result = await reply.promise;
          return Response.json(stats({ kind: result.kind, ...(result.code ? { code: result.code } : {}) }));
        } finally { clearTimeout(timer); probes.delete(requestId); }
      }
      if (operation === 'drop-before') state.dropBefore = true;
      if (operation === 'drop-acceptance') state.dropReplies = true;
      if (operation === 'restore') { state.dropBefore = false; state.dropReplies = false; }
      if (operation === 'repeat') {
        if (!invocation || !invocationSocket || invocationSocket.readyState !== WebSocket.OPEN) return new Response(null, { status: 409 });
        invocationSocket.send(JSON.stringify(invocation));
      }
      if (operation === 'disconnect') for (const socket of sockets) { socket.data.remote?.close(); socket.close(); }
      return Response.json(stats());
    }
    const upstream = new URL(url.pathname + url.search, process.env.RELAY);
    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      upstream.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
      const authorization = request.headers.get('authorization');
      if (server.upgrade(request, { data: { upstream: upstream.href, authorization, pending: [] } })) return;
      return new Response(null, { status: 400 });
    }
    return fetch(new Request(upstream, request));
  },
  websocket: {
    open(socket) {
      sockets.add(socket);
      const remote = new WebSocket(socket.data.upstream, { headers: socket.data.authorization ? { authorization: socket.data.authorization } : {} });
      socket.data.remote = remote;
      remote.onopen = () => { for (const message of socket.data.pending) remote.send(message); socket.data.pending = []; };
      remote.onmessage = event => {
        const value = JSON.parse(String(event.data));
        if (value.type === 'browser_response' && probes.has(value.requestId)) { probes.get(value.requestId)(value.response); return; }
        if (state.dropReplies && (value.type === 'browser_response' || value.type === 'browser_event')) { state.droppedReplies++; return; }
        socket.send(event.data);
      };
      remote.onclose = () => socket.close();
      remote.onerror = () => socket.close();
    },
    message(socket, raw) {
      const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString();
      const value = JSON.parse(text);
      if (value.type === 'browser_request' && value.owner) owners.set(value.owner.parentSessionId, { owner: value.owner, remote: socket.data.remote });
      if (value.type === 'browser_request' && value.operation === 'invoke') {
        state.invocations++;
        invocation = value;
        invocationSocket = socket.data.remote;
        if (state.dropBefore) return;
      }
      if (socket.data.remote?.readyState === WebSocket.OPEN) socket.data.remote.send(text);
      else if (socket.data.pending.length < 100) socket.data.pending.push(text);
      else socket.close();
    },
    close(socket) { sockets.delete(socket); socket.data.remote?.close(); }
  }
});
`;

const startCli = async (input: {
  api: string;
  relay: string;
  root: string;
  cliRoot: string;
  token: string;
}) => {
  const password = randomBytes(24).toString('hex');
  const directory = join(input.root, 'project');
  await mkdir(directory, { mode: 0o700, recursive: true });
  let origin = '';
  let child: ChildProcess | undefined;
  const request = <Value>(path: string, schema: z.ZodType<Value>, init: RequestInit = {}) => {
    const url = new URL(path, origin);
    url.searchParams.set('directory', directory);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Basic ${Buffer.from(`kilo:${password}`).toString('base64')}`);
    headers.set('content-type', 'application/json');
    headers.set('x-kilo-directory', directory);
    return readJson(url, schema, { ...init, headers });
  };
  const start = async (): Promise<void> => {
    const port = freePort();
    origin = `http://127.0.0.1:${port}`;
    child = spawn(
      'bun',
      [
        '--no-env-file',
        'run',
        '--conditions=browser',
        'src/index.ts',
        'serve',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: join(input.cliRoot, 'packages/opencode'),
        env: {
          HOME: process.env['HOME'],
          KILO_API_KEY: input.token,
          KILO_API_URL: input.api,
          KILO_CLIENT: 'cli',
          KILO_SERVER_PASSWORD: password,
          KILO_SESSION_INGEST_URL: input.relay,
          PATH: process.env['PATH'],
          TMPDIR: process.env['TMPDIR'],
          XDG_CACHE_HOME: join(input.root, 'cache'),
          XDG_CONFIG_HOME: join(input.root, 'config'),
          XDG_DATA_HOME: join(input.root, 'data'),
          XDG_STATE_HOME: join(input.root, 'state'),
        },
        stdio: 'ignore',
      }
    );
    await once(child, 'spawn');
    await expect
      .poll(
        async () => {
          try {
            return await request('/global/health', z.object({ healthy: z.boolean() }));
          } catch {
            return null;
          }
        },
        { message: 'The source CLI did not become healthy.', timeout: 60_000 }
      )
      .toMatchObject({ healthy: true });
    await request('/remote/enable', remoteSchema, { method: 'POST' });
    await expect
      .poll(() => request('/remote/status', remoteSchema), { timeout: 30_000 })
      .toMatchObject({ connected: true, enabled: true });
  };
  const stop = async (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): Promise<void> => {
    if (child !== undefined) {
      await stopChild(child, signal);
    }
  };
  try {
    await start();
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    createParent: (title: string) =>
      request('/session', sessionSchema, { body: JSON.stringify({ title }), method: 'POST' }),
    directory,
    request,
    restart: async () => {
      await stop('SIGKILL');
      await start();
    },
    running: () => child?.exitCode === null && child.signalCode === null,
    sendPrompt: async (sessionID: string, text: string): Promise<void> => {
      const url = new URL(`/session/${sessionID}/prompt_async`, origin);
      url.searchParams.set('directory', directory);
      const response = await fetch(url, {
        body: JSON.stringify({ model: cliModel, parts: [{ text, type: 'text' }] }),
        headers: {
          accept: 'application/json',
          authorization: `Basic ${Buffer.from(`kilo:${password}`).toString('base64')}`,
          'content-type': 'application/json',
          'x-kilo-directory': directory,
        },
        method: 'POST',
      });
      if (response.status !== 204 || (await response.text()) !== '') {
        throw new Error('CLI prompt submission did not return empty HTTP 204.');
      }
    },
    stop,
  };
};
type Cli = Awaited<ReturnType<typeof startCli>>;
type Parent = { cli: Cli; id: string };

const callTool = async (
  parent: Parent,
  args: BrowserTaskArguments,
  parentOnly = ''
): Promise<Output> => {
  const before = await parent.cli.request(`/session/${parent.id}/message`, messagesSchema);
  const known = new Set(
    before
      .flatMap(message => message.parts)
      .flatMap(part => {
        const parsed = toolPartSchema.safeParse(part);
        return parsed.success ? [parsed.data.id] : [];
      })
  );
  await parent.cli.sendPrompt(
    parent.id,
    `${parentOnly}\nCall browser_task exactly once with these exact arguments: ${JSON.stringify(args)}. Do not use another tool. Do not copy parent-only text into the goal. Return the tool result.`
  );
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    if (!parent.cli.running()) {
      throw new Error('The owning CLI stopped during this tool call.');
    }
    const permissions = await parent.cli.request('/permission', permissionSchema);
    for (const permission of permissions.filter(item => item.sessionID === parent.id)) {
      if (permission.permission !== 'browser_task') {
        throw new Error(
          `Unexpected CLI permission: ${permission.permission}. No permission was granted.`
        );
      }
      await parent.cli.request(`/permission/${permission.id}/reply`, z.boolean(), {
        body: JSON.stringify({ reply: 'once' }),
        method: 'POST',
      });
    }
    const messages = await parent.cli.request(`/session/${parent.id}/message`, messagesSchema);
    const calls = messages
      .flatMap(message => message.parts)
      .flatMap(part => {
        const parsed = toolPartSchema.safeParse(part);
        return parsed.success && !known.has(parsed.data.id) ? [parsed.data] : [];
      });
    for (const part of calls) {
      if (part.state.status === 'error') {
        throw new Error('The real browser_task tool returned a tool error.');
      }
      // A pending part can still contain streamed, incomplete arguments.
      if (part.state.status === 'running' || part.state.status === 'completed') {
        expect(browserTaskArgumentsSchema.parse(part.state.input)).toEqual(args);
      }
      if (part.state.status === 'completed') {
        const { output } = part.state;
        if (output === undefined) {
          throw new Error('The completed browser_task has no output.');
        }
        const result = outputSchema.parse(JSON.parse(output));
        await expect
          .poll(
            async () => {
              const states = await parent.cli.request(
                '/session/status',
                z.record(z.string(), z.object({ type: z.string() }))
              );
              return states[parent.id]?.type ?? 'idle';
            },
            { intervals: [1000], timeout: 30_000 }
          )
          .toBe('idle');
        return result;
      }
    }
    await delay(1000);
  }
  throw new Error('The real browser_task exceeded its finite acceptance deadline.');
};

const controls = (panel: Page) => panel.getByRole('region', { name: 'CLI task supervision' });
const approveTab = async (panel: Page, title = 'Browser acceptance A'): Promise<void> => {
  await expect(
    controls(panel).getByRole('button', { exact: true, name: 'Approve tab' })
  ).toBeDisabled();
  await controls(panel).getByLabel('Tab to approve').selectOption({ label: title });
  await controls(panel).getByRole('button', { exact: true, name: 'Approve tab' }).click();
};
const enableProvider = async (panel: Page) => {
  await selectModelById(panel, model);
  await panel.getByLabel('Settings', { exact: true }).click();
  const settings = panel.getByRole('region', { name: 'CLI task settings' });
  const text = await settings.getByText(/Provider ID:/u).textContent();
  const providerId = browserProviderIdSchema.parse(text?.match(/bp_[a-f0-9-]{36}/u)?.[0]);
  await settings.getByLabel('Model', { exact: true }).click();
  await panel
    .getByRole('dialog', { name: 'Select model' })
    .locator(`button[data-model-id="${model}"]`)
    .click();
  await settings.getByRole('button', { name: /Safe mode/u }).click();
  await settings.getByRole('button', { exact: true, name: 'Dangerous' }).click();
  await settings.getByRole('switch', { exact: true, name: 'CLI tasks' }).click();
  await expect(settings.getByRole('switch', { exact: true, name: 'CLI tasks' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await panel.getByLabel('Close settings').click();
  await expect(controls(panel)).toContainText('Enabled — idle');
  return providerId;
};

const withLive = async (
  run: (live: {
    a1: Parent;
    a2: Parent;
    b1: Parent;
    panel: Page;
    target: Page;
    other: Page;
    deliveries: Delivery[];
    modelRequests: z.infer<typeof gatewayRequestSchema>[];
    capture: (name: string) => Promise<void>;
    evidence: Evidence;
    proxy: (operation: string, target?: ProbeTarget) => Promise<z.infer<typeof proxyStatsSchema>>;
    loseProvider: () => Promise<void>;
    closeBrowser: () => Promise<void>;
  }) => Promise<void>
): Promise<void> => {
  const scratch = required('SCRATCH');
  const cliRoot = required('KILO_CLI_WORKTREE');
  const email = required('LOCAL_USER_EMAIL');
  const token = required('KILO_API_KEY');
  await access(scratch);
  await access(join(cliRoot, 'packages/opencode/src/index.ts'));
  const statusText = execFileSync('pnpm', ['-s', 'dev:status', '--json'], {
    cwd: cloudRoot,
    encoding: 'utf8',
  });
  const status = statusSchema.parse(JSON.parse(statusText));
  const service = (name: string) => {
    const value = status.services.find(item => item.name === name && item.status === 'up');
    if (value === undefined) {
      throw new Error(`Prepare ${name} with KILO_PORT_OFFSET=auto before live acceptance.`);
    }
    return value;
  };
  const api = `http://localhost:${service('nextjs').port}`;
  const relay = `http://localhost:${service('cloudflare-session-ingest').port}`;
  // Reuse the repository resolver, but reject missing services instead of using its fallback ports.
  const exports = execFileSync(
    process.execPath,
    [join(cloudRoot, 'apps/extension/scripts/resolve-e2e-ports.mjs')],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        VITE_CLOUD_AGENT_WS_URL: '',
        VITE_KILO_API_BASE_URL: '',
        VITE_SESSION_INGEST_WS_URL: '',
      },
      input: statusText,
    }
  );
  const relayWs = exports.match(/VITE_SESSION_INGEST_WS_URL=(ws:\/\/localhost:[0-9]+)/u)?.[1];
  if (relayWs !== relay.replace('http:', 'ws:')) {
    throw new Error('The resolver and live service status disagree.');
  }
  const catalog = await readJson(new URL('/api/gateway/models', api), modelCatalogSchema, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!catalog.data.some(item => item.id === model)) {
    throw new Error(
      `Verification blocked: required model ${model} is unavailable. No model was substituted.`
    );
  }
  const root = await mkdtemp(join(scratch, 'browser-task-live-'));
  const evidence: Evidence = {
    checks: [
      'gateway catalog: Content-Type application/json',
      'gateway catalog: parsed data[].id',
      'dev:status: parsed running service names and ports',
      'resolve-e2e-ports: relay origin matches status',
    ],
    clock: 'production deadlines',
    model: `kilo/${model}`,
    scenarios: [],
    screenshots: [],
  };
  const clis: Cli[] = [];
  const controlKey = randomBytes(24).toString('hex');
  const proxyPort = freePort();
  const targetPort = freePort();
  const proxyProcess = spawn('bun', ['--no-env-file', '--eval', faultProxySource], {
    cwd: root,
    env: {
      CONTROL_KEY: controlKey,
      PATH: process.env['PATH'],
      PORT: String(proxyPort),
      RELAY: relay,
    },
    stdio: 'ignore',
  });
  const proxy = (operation: string, target?: ProbeTarget) =>
    readJson(new URL(`http://127.0.0.1:${proxyPort}/control`), proxyStatsSchema, {
      body: JSON.stringify({ operation, ...target }),
      headers: { 'content-type': 'application/json', 'x-kilo-e2e-control': controlKey },
      method: 'POST',
    });
  const targetServer = createServer((request, response) => {
    const label = request.url === '/b' ? 'B' : 'A';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><title>Browser acceptance ${label}</title><h1>Browser acceptance ${label}</h1><p>Observed evidence ${label} only.</p><button id="effect" onclick="document.querySelector('#count').textContent = String(Number(document.querySelector('#count').textContent) + 1)">Apply once</button><output id="count">0</output>`
    );
  });
  let launched: Awaited<ReturnType<typeof launchExtensionContext>> | undefined;
  let browserClosed = false;
  try {
    await once(proxyProcess, 'spawn');
    await expect
      .poll(
        async () => {
          try {
            return await proxy('stats');
          } catch {
            return null;
          }
        },
        { timeout: 15_000 }
      )
      .toMatchObject({ invocations: 0 });
    targetServer.listen(targetPort, '127.0.0.1');
    await once(targetServer, 'listening');
    for (const label of ['A', 'B']) {
      clis.push(
        await startCli({
          api,
          cliRoot,
          relay: label === 'A' ? `http://127.0.0.1:${proxyPort}` : relay,
          root: join(root, `cli-${label}`),
          token,
        })
      );
    }
    const [cliA, cliB] = clis;
    if (cliA === undefined || cliB === undefined) {
      throw new Error('Both source CLI processes are required.');
    }
    const a1 = { cli: cliA, ...(await cliA.createParent('Browser acceptance parent A1')) };
    const a2 = { cli: cliA, ...(await cliA.createParent('Browser acceptance parent A2')) };
    const b1 = { cli: cliB, ...(await cliB.createParent('Browser acceptance parent B1')) };
    launched = await launchExtensionContext();
    const { context, extensionId } = launched;
    const deliveries: Delivery[] = [];
    const modelRequests: z.infer<typeof gatewayRequestSchema>[] = [];
    const providerSockets: WebSocketRoute[] = [];
    await context.route('https://app.kilo.ai/**', route => route.abort());
    await context.routeWebSocket(`${relayWs}/api/user/web**`, route => {
      const server = route.connectToServer();
      providerSockets.push(server);
      server.onMessage(raw => {
        const parsed = browserProviderInboundMessageSchema.safeParse(JSON.parse(String(raw)));
        if (parsed.success && parsed.data.type === 'provider_job') {
          deliveries.push(parsed.data);
        }
        route.send(raw);
      });
    });
    context.on('request', request => {
      if (request.url() === `${api}/api/gateway/v1/chat/completions`) {
        modelRequests.push(gatewayRequestSchema.parse(request.postDataJSON()));
      }
    });
    const target = await context.newPage();
    const other = await context.newPage();
    for (const [page, path, label] of [
      [target, '/a', 'A'],
      [other, '/b', 'B'],
    ] as const) {
      const navigation = await page.goto(`http://127.0.0.1:${targetPort}${path}`);
      expect(navigation?.headers()['content-type']).toContain('text/html');
      await expect(page.locator('h1')).toHaveText(`Browser acceptance ${label}`);
    }
    evidence.checks.push(
      'target pages: Content-Type text/html',
      'target pages: required heading and deterministic controls'
    );
    const panel = await context.newPage();
    await panel.setViewportSize({ height: 720, width: 320 });
    await signInWithLocalDeviceAuth({
      context,
      extensionId,
      localBackendUrl: api,
      localUserEmail: email,
      sidePanel: panel,
    });
    const capture = async (name: string): Promise<void> => {
      const path = join(root, `${name}.png`);
      await panel.screenshot({ path });
      evidence.screenshots.push(path);
      await test.info().attach(name, { contentType: 'image/png', path });
    };
    await run({
      a1,
      a2,
      b1,
      capture,
      closeBrowser: async () => {
        await context.close();
        browserClosed = true;
      },
      deliveries,
      evidence,
      loseProvider: async () => {
        for (const socket of providerSockets) {
          await socket.close({ code: 1011, reason: 'Acceptance connection loss' });
        }
      },
      modelRequests,
      other,
      panel,
      proxy,
      target,
    });
    evidence.checks.push(
      'CLI JSON responses: Content-Type checked before parsing',
      'CLI JSON responses: endpoint schemas validated',
      'provider deliveries: shared wire schema validated'
    );
  } finally {
    await Promise.all(clis.map(cli => cli.stop()));
    await stopChild(proxyProcess);
    if (launched !== undefined) {
      if (!browserClosed) {
        await launched.context.close();
      }
      await rm(launched.userDataDir, { force: true, recursive: true });
    }
    targetServer.closeAllConnections();
    if (targetServer.listening) {
      const closed = once(targetServer, 'close');
      targetServer.close();
      await closed;
    }
    await Promise.all(
      ['A', 'B'].map(label => rm(join(root, `cli-${label}`), { force: true, recursive: true }))
    );
    const path = join(root, 'evidence.json');
    await writeFile(path, JSON.stringify(evidence, null, 2));
    await test
      .info()
      .attach('sanitized browser acceptance', { contentType: 'application/json', path });
  }
};

const heldGoal =
  'Use get_page_snapshot to read the approved page. Then call save_memory with text "Live browser acceptance A1" and wait for its approval. After approval, use eval to click #effect exactly once. Read #count and report the title, observed text, and count.';
const approveMemory = async (panel: Page): Promise<void> => {
  const dialog = panel.getByRole('dialog', { name: 'Add to memory' });
  await dialog.getByRole('button', { name: 'Save memory' }).click();
  await expect(dialog).toContainText('Saved to memory');
  await dialog.getByRole('button', { exact: true, name: 'Done' }).click();
};

test('real CLI parents route queued results and continue only their owned browser history', async () => {
  await withLive(async live => {
    const { a1, a2, b1, panel, target, other, deliveries, evidence } = live;
    const empty = await callTool(a1, { operation: 'list' });
    expect(empty.status).toBe('empty');
    expect(empty.providers).toEqual([]);
    await live.capture('disabled-empty-discovery');
    const provider = await enableProvider(panel);
    const discovery = await callTool(a1, { operation: 'list' });
    expect(discovery.providers).toContainEqual(
      expect.objectContaining({ availability: 'available', providerId: provider })
    );
    const resultA = callTool(
      a1,
      { goal: heldGoal, operation: 'run', provider_id: provider },
      'PARENT_ONLY_A1_CANARY'
    );
    await expect(controls(panel)).toContainText(a1.id, { timeout: 90_000 });
    await approveTab(panel);
    await expect(panel.getByRole('dialog', { name: 'Add to memory' })).toBeVisible({
      timeout: 90_000,
    });
    // Change the active tab after approval, while the real runner waits for memory consent.
    await other.bringToFront();
    await panel.bringToFront();
    const resultB = callTool(
      b1,
      {
        goal: 'BROWSER_HISTORY_B1_CANARY. Use only get_page_snapshot to read this approved page. Report its title and observed evidence. Do not change it.',
        operation: 'run',
        provider_id: provider,
      },
      'PARENT_ONLY_B1_CANARY'
    );
    await expect(
      panel
        .getByRole('dialog', { name: 'Add to memory' })
        .getByRole('list', { name: 'Queued CLI tasks' })
    ).toContainText(b1.id, { timeout: 90_000 });
    await live.capture('running-A1-queued-B1-memory-approval');
    await live.proxy('repeat');
    await approveMemory(panel);
    const outputA = await resultA;
    expect(outputA.status).toBe('succeeded');
    expect(outputA.effectsUncertain).toBe(false);
    expect(outputA.summary.length).toBeGreaterThan(15);
    await expect(target.locator('#count')).toHaveText('1');
    const taskA = browserTaskIdSchema.parse(outputA.browser_task_id);
    const originalJob = browserJobIdSchema.parse(outputA.job_id);
    await expect(controls(panel)).toContainText(b1.id, { timeout: 30_000 });
    await approveTab(panel, 'Browser acceptance B');
    const outputB = await resultB;
    const taskB = browserTaskIdSchema.parse(outputB.browser_task_id);
    expect(outputB.status).toBe('succeeded');
    expect(taskB).not.toBe(taskA);
    expect(outputA.evidence.some(item => item.url === target.url())).toBe(true);
    expect(outputB.evidence.some(item => item.url === other.url())).toBe(true);
    await expect(other.locator('#count')).toHaveText('0');
    const resultA2 = callTool(
      a2,
      {
        goal: 'BROWSER_HISTORY_A2_CANARY. Use only get_page_snapshot to read this page. Do not save a memory or change the page.',
        operation: 'run',
        provider_id: provider,
      },
      'PARENT_ONLY_A2_CANARY'
    );
    await expect(controls(panel)).toContainText(a2.id, { timeout: 90_000 });
    await approveTab(panel, 'Browser acceptance B');
    const outputA2 = await resultA2;
    expect(outputA2.status).toBe('succeeded');
    const taskA2 = browserTaskIdSchema.parse(outputA2.browser_task_id);
    expect([taskA, taskB]).not.toContain(taskA2);
    expect(deliveries.find(delivery => delivery.job.browserTaskId === taskA)?.ownerLabel).toBe(
      a1.id
    );
    expect(deliveries.find(delivery => delivery.job.browserTaskId === taskA2)?.ownerLabel).toBe(
      a2.id
    );
    const requestsBefore = live.modelRequests.length;
    const continuation = callTool(a1, {
      browser_task_id: taskA,
      goal: 'Read the current count and report it as "Current count: <value>". Quote the prior observed page text from this browser conversation. Do not click again.',
      operation: 'run',
      provider_id: provider,
    });
    await expect(controls(panel)).toContainText('Tab approval required', { timeout: 90_000 });
    expect(live.modelRequests).toHaveLength(requestsBefore);
    await approveTab(panel);
    const continued = await continuation;
    expect(continued.status).toBe('succeeded');
    expect(continued.effectsUncertain).toBe(false);
    expect(continued.summary).toContain('Current count: 1');
    expect(continued.summary).toContain('Observed evidence A only.');
    expect(continued.browser_task_id).toBe(taskA);
    expect(continued.job_id).not.toBe(originalJob);
    const continuationRequests = live.modelRequests.slice(requestsBefore);
    const userTurn = z.object({ content: z.string(), role: z.literal('user') });
    expect(
      continuationRequests.some(request =>
        request.messages.some(message => {
          const parsed = userTurn.safeParse(message);
          return parsed.success && parsed.data.content.includes(heldGoal);
        })
      )
    ).toBe(true);
    const requestText = JSON.stringify(continuationRequests);
    // Boolean assertions cannot dump real request bodies into a failing test's report.
    for (const marker of [
      'PARENT_ONLY_A1_CANARY',
      'PARENT_ONLY_A2_CANARY',
      'PARENT_ONLY_B1_CANARY',
      'BROWSER_HISTORY_A2_CANARY',
      'BROWSER_HISTORY_B1_CANARY',
      'Observed evidence B only.',
    ]) {
      expect(requestText.includes(marker)).toBe(false);
    }
    expect(live.modelRequests.every(request => request.model === model)).toBe(true);
    const countBeforeForeign = deliveries.length;
    for (const args of [
      { browser_task_id: taskA, operation: 'status' },
      { browser_task_id: taskA, operation: 'cancel' },
      { browser_task_id: taskA, goal: 'Read the count.', operation: 'run', provider_id: provider },
    ] satisfies BrowserTaskArguments[]) {
      const rejected = await callTool(a2, args);
      expect(rejected.status).toBe('rejected');
      expect(rejected.reason).toMatch(/^(?:owner_mismatch|not_found)$/u);
    }
    // Use A2's actual captured proof on its authenticated CLI socket. A random invalid proof
    // Would test authentication only, not isolation between two valid parents in one process.
    for (const operation of ['status', 'cancel', 'invoke']) {
      const denial = await live.proxy(`probe-${operation}`, {
        parent: a2.id,
        provider,
        task: taskA,
      });
      expect(denial.probe).toMatchObject({
        code: expect.stringMatching(/^(?:owner_mismatch|not_found)$/u),
        kind: 'error',
      });
    }
    expect(deliveries).toHaveLength(countBeforeForeign);
    await expect(target.locator('#count')).toHaveText('1');
    const original = await callTool(a1, {
      browser_task_id: taskA,
      job_id: originalJob,
      operation: 'status',
    });
    expect(original).toEqual(outputA);
    const beforeRestart = await callTool(a1, { browser_task_id: taskA, operation: 'status' });
    await a1.cli.restart();
    const afterRestart = await callTool(a1, { browser_task_id: taskA, operation: 'status' });
    expect(afterRestart).toEqual(beforeRestart);
    await panel.reload();
    await expect(controls(panel)).toContainText('Enabled — idle', { timeout: 30_000 });
    await expect(panel.getByRole('button', { exact: true, name: 'Approve tab' })).toHaveCount(0);
    await expect(target.locator('#count')).toHaveText('1');
    evidence.scenarios.push(
      `A1 ${taskA}: ${outputA.status}/${outputA.reason}; effects=1; evidence=${outputA.evidence.length}`,
      `B1 ${taskB}: ${outputB.status}/${outputB.reason}; effects=0`,
      `A2 ${taskA2}: ${outputA2.status}/${outputA2.reason}; effects=0`,
      'empty discovery',
      'two real CLI processes',
      'distinct owned conversations in process A',
      'named provider',
      'FIFO queue',
      'useful owned results',
      'duplicate invocation without replay',
      'fresh continuation consent',
      'isolated browser history',
      'foreign tool and relay denial',
      'real process restart',
      'immutable original and latest results',
      'reload without execution'
    );
    await live.capture('completed-owned-results');
  });
});

test('real CLI continuation pairs an interrupted multi-call batch without replay', async () => {
  await withLive(async live => {
    const { a1, panel, target, other } = live;
    const provider = await enableProvider(panel);
    const memoriesBefore = await readExtensionLocalStorage(panel, 'kiloAgentMemories');
    const interruptedGoal = `Return one batch of exactly three tool calls in this order: ${JSON.stringify(
      [
        { arguments: {}, name: 'get_page_snapshot' },
        { arguments: { text: 'Interrupted batch memory' }, name: 'save_memory' },
        {
          arguments: {
            code: 'document.querySelector("#effect").click(); return document.querySelector("#count").textContent;',
          },
          name: 'eval',
        },
      ]
    )}. Put all three calls in the same assistant response, not separate responses. The memory call waits for user approval before the page action can run.`;
    const running = callTool(a1, {
      goal: interruptedGoal,
      operation: 'run',
      provider_id: provider,
    });
    await expect(controls(panel)).toContainText('Tab approval required', { timeout: 90_000 });
    await approveTab(panel);
    const card = panel.getByRole('dialog', { name: 'Add to memory' });
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(target.locator('#count')).toHaveText('0');
    await live.capture('interrupted-batch-before-stop');
    await card.getByRole('button', { name: 'Stop CLI task' }).click();
    const stopped = await running;
    expect(stopped.status).toBe('cancelled');
    expect(stopped.reason).toBe('cancelled');
    expect(stopped.effectsUncertain).toBe(true);
    const task = browserTaskIdSchema.parse(stopped.browser_task_id);
    const originalJob = browserJobIdSchema.parse(stopped.job_id);
    const readHistory = async () => {
      const parsed = browserHistorySchema.safeParse(
        await readExtensionLocalStorage(panel, 'kiloBrowserTasks')
      );
      if (!parsed.success) {
        throw new Error('The persisted browser history has an invalid structure.');
      }
      return parsed.data.histories.find(history => history.browserTaskId === task)?.events;
    };
    await expect
      .poll(async () => {
        const storedHistory = await readHistory();
        return storedHistory?.some(event => event.type === 'tool-call') === true;
      })
      .toBe(true);
    const history = await readHistory();
    if (history === undefined) {
      throw new Error('The interrupted browser history is missing.');
    }
    const batchStart = history.findIndex(event => event.type === 'tool-call');
    const batch = history
      .slice(batchStart, batchStart + 3)
      .filter(event => event.type === 'tool-call');
    expect(batch.map(call => call.name)).toEqual(['get_page_snapshot', 'save_memory', 'eval']);
    const [snapshotCall, memoryCall, skippedCall] = batch;
    if (snapshotCall === undefined || memoryCall === undefined || skippedCall === undefined) {
      throw new Error('The required model did not produce the requested multi-call batch.');
    }
    const confirmed = history.find(
      event => event.type === 'tool-result' && event.toolCallId === snapshotCall.id
    );
    if (confirmed?.type !== 'tool-result' || !confirmed.ok) {
      throw new Error('The interrupted batch has no confirmed snapshot result.');
    }
    expect(JSON.stringify(confirmed.value).includes('Observed evidence A only.')).toBe(true);
    for (const call of [memoryCall, skippedCall]) {
      expect(
        history.some(event => event.type === 'tool-result' && event.toolCallId === call.id)
      ).toBe(false);
    }
    await expect(card).toBeHidden();
    await expect(target.locator('#count')).toHaveText('0');
    const requestsAfterStop = live.modelRequests.length;
    await expect(controls(panel)).toContainText('Recovery required');
    await expect
      .poll(() =>
        panel.evaluate(async () => {
          const locks = await navigator.locks.query();
          return (locks.held ?? []).filter(lock => lock.name === 'kilo:browser-execution').length;
        })
      )
      .toBe(0);
    await controls(panel).getByRole('button', { name: 'Check recovery readiness' }).click();
    await expect(panel.getByRole('button', { name: 'Recover browser control' })).toHaveCount(0);
    await target.close();
    await controls(panel).getByRole('button', { name: 'Check recovery readiness' }).click();
    await panel.getByRole('button', { name: 'Recover browser control' }).click();
    await expect(controls(panel)).toContainText('Enabled — idle', { timeout: 30_000 });
    expect(live.modelRequests).toHaveLength(requestsAfterStop);

    const responses: { contentType: string | undefined; status: number }[] = [];
    panel.context().on('response', response => {
      if (response.url().endsWith('/api/gateway/v1/chat/completions')) {
        responses.push({
          contentType: response.headers()['content-type'],
          status: response.status(),
        });
      }
    });
    const continuation = callTool(a1, {
      browser_task_id: task,
      goal: 'Use only get_page_snapshot to read the newly approved page. Report its observed text and "Current count: <value>". Quote the prior confirmed page text from this browser history. Do not repeat the skipped memory save or eval action; no click or memory save is authorized.',
      operation: 'run',
      provider_id: provider,
    });
    await expect(controls(panel)).toContainText('Tab approval required', { timeout: 90_000 });
    expect(live.modelRequests).toHaveLength(requestsAfterStop);
    await expect(other.locator('#count')).toHaveText('0');
    await live.capture('interrupted-batch-fresh-consent');
    await approveTab(panel, 'Browser acceptance B');
    const continued = await continuation;
    expect(continued.status).toBe('succeeded');
    expect(continued.reason).toBe('completed');
    expect(continued.effectsUncertain).toBe(false);
    expect(continued.browser_task_id).toBe(task);
    expect(continued.job_id).not.toBe(originalJob);
    expect(continued.summary).toContain('Current count: 0');
    expect(continued.summary).toContain('Observed evidence A only.');
    expect(continued.summary).toContain('Observed evidence B only.');
    expect(continued.evidence.some(item => item.url === other.url())).toBe(true);
    await expect(other.locator('#count')).toHaveText('0');
    expect(
      JSON.stringify(await readExtensionLocalStorage(panel, 'kiloAgentMemories')) ===
        JSON.stringify(memoriesBefore)
    ).toBe(true);
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(
      responses.every(response => response.contentType?.includes('text/event-stream') === true)
    ).toBe(true);

    const continuationRequests = live.modelRequests.slice(requestsAfterStop);
    expect(continuationRequests.length).toBeGreaterThan(0);
    const batchIds = batch.map(call => call.providerToolCallId ?? call.id);
    for (const request of continuationRequests) {
      expect(request.model).toBe(model);
      const parsed = z.array(replayMessageSchema).safeParse(request.messages);
      if (!parsed.success) {
        throw new Error('The continuation gateway messages have an invalid structure.');
      }
      const { data: messages } = parsed;
      const pending = new Set<string>();
      for (const message of messages) {
        if (message.role === 'tool') {
          expect(message.tool_calls).toBeUndefined();
          expect(message.tool_call_id !== undefined && pending.delete(message.tool_call_id)).toBe(
            true
          );
        } else {
          expect(pending.size).toBe(0);
          expect(message.tool_call_id).toBeUndefined();
          for (const call of message.tool_calls ?? []) {
            expect(message.role).toBe('assistant');
            expect(pending.has(call.id)).toBe(false);
            pending.add(call.id);
          }
        }
      }
      expect(pending.size).toBe(0);
      const replayedBatch = messages.find(
        message => message.tool_calls?.some(call => call.id === batchIds[0]) === true
      );
      expect(replayedBatch?.tool_calls?.map(call => call.id)).toEqual(batchIds);
      for (const [index, id] of batchIds.entries()) {
        const reply = messages.find(
          message => message.role === 'tool' && message.tool_call_id === id
        );
        let projection: z.infer<typeof toolProjectionSchema>;
        try {
          projection = toolProjectionSchema.parse(JSON.parse(z.string().parse(reply?.content)));
        } catch {
          throw new Error('The continuation contains an invalid tool result projection.');
        }
        if (index === 0) {
          expect(projection.ok).toBe(true);
          expect(projection.effectsUncertain === true).toBe(false);
          expect(JSON.stringify(projection.value) === JSON.stringify(confirmed.value)).toBe(true);
        } else {
          expect(projection.ok).toBe(false);
          expect(projection.effectsUncertain).toBe(true);
          expect(projection.value).toBeUndefined();
          expect(projection.error?.includes('No result was recorded')).toBe(true);
          expect(projection.error?.includes('Execution and effects are unknown')).toBe(true);
          expect(projection.error?.includes('Do not automatically retry')).toBe(true);
        }
      }
    }
    const continuedHistory = await readHistory();
    expect(
      JSON.stringify(continuedHistory?.slice(0, history.length)) === JSON.stringify(history)
    ).toBe(true);
    for (const call of [memoryCall, skippedCall]) {
      expect(
        continuedHistory?.some(
          event => event.type === 'tool-result' && event.toolCallId === call.id
        )
      ).toBe(false);
    }
    const original = await callTool(a1, {
      browser_task_id: task,
      job_id: originalJob,
      operation: 'status',
    });
    expect(original).toEqual(stopped);
    live.evidence.checks.push(
      'continuation responses: HTTP 200 and Content-Type text/event-stream',
      'continuation requests: parsed roles, unique call IDs, exactly paired results',
      'confirmed snapshot retained; missing results stay uncertain and never enter stored history'
    );
    live.evidence.scenarios.push(
      `interrupted multi-call continuation: ${stopped.status}/${stopped.reason} -> ${continued.status}/${continued.reason}`,
      'fresh consent after explicit recovery',
      'required real model accepts paired history',
      'useful prior and current observations',
      'skipped eval and memory save not replayed; effects=0',
      'immutable original cancellation'
    );
    await live.capture('interrupted-batch-useful-continuation');
  });
});

for (const loss of ['before acceptance', 'entire acceptance response'] as const) {
  test(`real process restart recovers after loss of ${loss} without a fresh invocation`, async () => {
    await withLive(async live => {
      const provider = await enableProvider(live.panel);
      await live.proxy(loss === 'before acceptance' ? 'drop-before' : 'drop-acceptance');
      const outstanding = callTool(live.a1, {
        goal: heldGoal,
        operation: 'run',
        provider_id: provider,
      }).then(
        value => ({ value }),
        () => ({ value: undefined })
      );
      await expect
        .poll(
          async () => {
            const stats = await live.proxy('stats');
            return stats.invocations;
          },
          { intervals: [1000], timeout: 90_000 }
        )
        .toBeGreaterThan(0);
      if (loss === 'entire acceptance response') {
        await expect(controls(live.panel)).toContainText('Tab approval required', {
          timeout: 30_000,
        });
        await expect
          .poll(async () => {
            const stats = await live.proxy('stats');
            return stats.droppedReplies;
          })
          .toBeGreaterThan(0);
      }
      const [accepted] = live.deliveries;
      const beforeCrash = await live.proxy('stats');
      await live.a1.cli.stop('SIGKILL');
      const lost = await outstanding;
      expect(lost.value?.browser_task_id).toBeUndefined();
      await live.proxy('restore');
      await live.a1.cli.restart();
      const recovered = await callTool(live.a1, { operation: 'recover' });
      if (loss === 'entire acceptance response') {
        if (accepted === undefined) {
          throw new Error('No real accepted dispatch was observed.');
        }
        const original = recovered.jobs?.find(job => job.job_id === accepted.job.jobId);
        expect(original).toMatchObject({
          browser_task_id: accepted.job.browserTaskId,
          invocation_id: accepted.job.invocationId,
          job_id: accepted.job.jobId,
        });
        if (original?.status === 'awaiting_approval') {
          await expect(controls(live.panel)).toContainText('Tab approval required');
          await approveTab(live.panel);
          await expect(live.panel.getByRole('dialog', { name: 'Add to memory' })).toBeVisible({
            timeout: 90_000,
          });
          await approveMemory(live.panel);
          await expect(live.target.locator('#count')).toHaveText('1', { timeout: 90_000 });
          await expect(controls(live.panel)).toContainText('Last outcome: succeeded', {
            timeout: 90_000,
          });
          const status = await callTool(live.a1, {
            browser_task_id: accepted.job.browserTaskId,
            operation: 'status',
          });
          expect(status.status).toBe('succeeded');
          expect(status.job_id).toBe(accepted.job.jobId);
        } else {
          // A slow real restart can consume the production approval deadline. Recovery must
          // Still return the original terminal record, never create another invocation.
          expect(original?.status).toBe('timed_out');
          expect(original?.reason).toBe('approval_timeout');
          await expect(live.target.locator('#count')).toHaveText('0');
        }
        expect(live.deliveries).toHaveLength(1);
      } else {
        expect(recovered.jobs?.some(job => job.status === 'not_found')).toBe(true);
        expect(live.deliveries).toHaveLength(0);
        await expect(live.target.locator('#count')).toHaveText('0');
      }
      const afterRecovery = await live.proxy('stats');
      expect(afterRecovery.invocations).toBe(beforeCrash.invocations);
      live.evidence.scenarios.push(
        `restart after ${loss}: ${recovered.status}/${recovered.reason}`,
        'durable outgoing intent',
        'lookup-only recovery',
        'original handles or authoritative not-found',
        'no automatic replay'
      );
      await live.capture('recovered-original-intent');
    });
  });
}

for (const loss of ['after dispatch', 'before completion'] as const) {
  test(`real connection loss ${loss} recovers the existing result with one browser side effect`, async () => {
    await withLive(async live => {
      const provider = await enableProvider(live.panel);
      const running = callTool(live.a1, {
        goal: heldGoal,
        operation: 'run',
        provider_id: provider,
      });
      await expect(controls(live.panel)).toContainText('Tab approval required', {
        timeout: 90_000,
      });
      await approveTab(live.panel);
      await expect(live.panel.getByRole('dialog', { name: 'Add to memory' })).toBeVisible({
        timeout: 90_000,
      });
      const [accepted] = live.deliveries;
      if (accepted === undefined) {
        throw new Error('The real relay did not dispatch the CLI invocation.');
      }
      await live.proxy('repeat');
      await live.proxy(loss === 'after dispatch' ? 'disconnect' : 'drop-acceptance');
      await approveMemory(live.panel);
      await expect(live.target.locator('#count')).toHaveText('1', { timeout: 90_000 });
      await expect(controls(live.panel)).toContainText('Last outcome: succeeded', {
        timeout: 90_000,
      });
      if (loss === 'before completion') {
        const stats = await live.proxy('stats');
        expect(stats.droppedReplies).toBeGreaterThan(0);
        await live.proxy('disconnect');
        await live.proxy('restore');
      }
      const delivered = await running;
      if (delivered.status !== 'succeeded') {
        expect(delivered.reason).toBe('delivery_interrupted');
      }
      const status = await callTool(live.a1, {
        browser_task_id: accepted.job.browserTaskId,
        operation: 'status',
      });
      expect(status).toMatchObject({
        browser_task_id: accepted.job.browserTaskId,
        invocation_id: accepted.job.invocationId,
        job_id: accepted.job.jobId,
        reason: 'completed',
        status: 'succeeded',
      });
      expect(live.deliveries).toHaveLength(1);
      await expect(live.target.locator('#count')).toHaveText('1');
      live.evidence.scenarios.push(
        `${loss}: ${status.browser_task_id}; ${status.status}/${status.reason}; effects=1`,
        'same invocation across reconnection'
      );
      await live.capture(`${loss.replaceAll(' ', '-')}-recovered`);
    });
  });
}

for (const [failure, reasons] of [
  ['Stop', ['cancelled']],
  ['tab loss', ['tab_lost']],
  ['provider socket loss', ['provider_lost', 'lease_expired', 'provider_unavailable']],
  ['panel close', ['provider_lost', 'lease_expired', 'provider_unavailable']],
  ['panel reload', ['provider_lost', 'lease_expired', 'provider_unavailable']],
  ['disablement', ['provider_unavailable']],
  ['extension shutdown', ['provider_lost', 'lease_expired', 'provider_unavailable']],
  ['execution timeout', ['execution_timeout']],
] as const) {
  test(`real delegated ${failure} settles active and queued parents with finite outcomes`, async () => {
    await withLive(async live => {
      const provider = await enableProvider(live.panel);
      const goal =
        failure === 'disablement'
          ? 'Use get_page_snapshot to read the approved page, then call save_memory with text "Live disablement observation" and wait for approval. After approval, report the observed title and text. Do not use eval, click, or change the page.'
          : heldGoal;
      const active = callTool(live.a1, { goal, operation: 'run', provider_id: provider });
      await expect(controls(live.panel)).toContainText('Tab approval required', {
        timeout: 90_000,
      });
      await approveTab(live.panel);
      const card = live.panel.getByRole('dialog', { name: 'Add to memory' });
      await expect(card).toBeVisible({ timeout: 90_000 });
      const beforeCount = await live.target.locator('#count').textContent();
      const queued = callTool(live.b1, {
        goal: 'Read the page only after new tab approval.',
        operation: 'run',
        provider_id: provider,
      });
      await expect(card.getByRole('list', { name: 'Queued CLI tasks' })).toContainText(live.b1.id, {
        timeout: 90_000,
      });
      await live.capture(`${failure.replaceAll(' ', '-')}-before`);
      if (failure === 'Stop') {
        await card.getByRole('button', { name: 'Stop CLI task' }).click();
      }
      if (failure === 'tab loss') {
        await live.target.close();
      }
      if (failure === 'provider socket loss') {
        await live.loseProvider();
      }
      if (failure === 'panel close') {
        await live.panel.close();
      }
      if (failure === 'panel reload') {
        await live.panel.reload();
      }
      if (failure === 'extension shutdown') {
        await live.closeBrowser();
      }
      if (failure === 'disablement') {
        // Approve, never reject, the memory card. Hold the next real request until disablement.
        const gate = Promise.withResolvers<void>();
        let requestHeld = false;
        await live.panel.context().route('**/api/gateway/v1/chat/completions', async route => {
          requestHeld = true;
          await gate.promise;
          await route.continue();
        });
        try {
          await approveMemory(live.panel);
          await expect.poll(() => requestHeld, { timeout: 30_000 }).toBe(true);
          await live.panel.getByLabel('Settings', { exact: true }).click();
          const settings = live.panel.getByRole('dialog', { name: 'Settings panel' });
          const toggle = settings.getByRole('switch', { exact: true, name: 'CLI tasks' });
          await toggle.click();
          await expect(
            settings.getByRole('group', { name: 'Confirm CLI task disablement' })
          ).toContainText('Issued actions are not undone');
          await expect(toggle).toHaveAttribute('aria-checked', 'true');
          const supervision = settings.getByRole('region', { name: 'CLI task supervision' });
          await expect(supervision).toContainText('CLI tasks: Running');
          await expect(supervision).toContainText(live.a1.id);
          await expect(supervision.getByRole('button', { name: 'Stop CLI task' })).toBeEnabled();
          await expect(supervision.getByRole('list', { name: 'Queued CLI tasks' })).toContainText(
            live.b1.id
          );
          await expect(live.target.locator('#count')).toHaveText(beforeCount ?? '0');
          await live.capture('disablement-confirmation-active-and-queued');
          await settings.getByRole('button', { name: 'Disable CLI tasks' }).click();
          await expect(toggle).toHaveAttribute('aria-checked', 'false');
          await expect(supervision).toContainText('CLI tasks: Disabled');
        } finally {
          gate.resolve();
        }
      }
      // The timeout case keeps memory consent open for the production ten-minute deadline.
      // No fake clock, shortened deadline, or substitute model enters this live path.
      const [result, queuedResult] = await Promise.all([active, queued]);
      expect(terminal.has(result.status)).toBe(true);
      expect(result.status).not.toBe('succeeded');
      expect(reasons).toContain(result.reason);
      expect(terminal.has(queuedResult.status)).toBe(true);
      expect(queuedResult.reason).toBe('provider_unavailable');
      if (failure === 'disablement') {
        for (const outcome of [result, queuedResult]) {
          expect(outcome.status).toBe('interrupted');
          expect(outcome.reason).toBe('provider_unavailable');
        }
      }
      const task = browserTaskIdSchema.parse(result.browser_task_id);
      const stored = await callTool(live.a1, {
        browser_task_id: task,
        job_id: browserJobIdSchema.parse(result.job_id),
        operation: 'status',
      });
      expect(stored).toEqual(result);
      const storedQueued = await callTool(live.b1, {
        browser_task_id: browserTaskIdSchema.parse(queuedResult.browser_task_id),
        job_id: browserJobIdSchema.parse(queuedResult.job_id),
        operation: 'status',
      });
      expect(storedQueued).toEqual(queuedResult);
      if (failure !== 'tab loss' && failure !== 'extension shutdown') {
        await expect(live.target.locator('#count')).toHaveText(beforeCount ?? '0');
      }
      if (failure !== 'extension shutdown') {
        await expect(live.other.locator('#count')).toHaveText('0');
      }
      if (failure === 'panel reload') {
        await expect(
          live.panel.getByRole('button', { exact: true, name: 'Approve tab' })
        ).toHaveCount(0);
        expect(
          live.deliveries.filter(delivery => delivery.job.browserTaskId === task)
        ).toHaveLength(1);
        await live.capture('reloaded-without-execution');
      }
      live.evidence.scenarios.push(
        `${failure}: ${task}; ${result.status}/${result.reason}`,
        `queued: ${queuedResult.status}/${queuedResult.reason}`,
        'finite outcomes',
        'immutable persisted terminal result',
        'no subsequent browser action'
      );
    });
  });
}
