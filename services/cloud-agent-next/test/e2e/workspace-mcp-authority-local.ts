/**
 * Local-only check of the built-in `kilo-cloud-agent` MCP connection across
 * the lifetime of a two-chat workspace. It drives the real Worker, Durable
 * Objects, sandbox, wrapper, Kilo runtime and local kilo-mcp with synthetic
 * identities and fake inference.
 *
 * The local Worker must run with `RUNTIME_AUTHORIZATION_LIFETIME_MS` in its
 * `.dev.vars` (for example 480000), so a runtime delegation expires within the
 * run. The script prints one JSON observation per step and never prints a
 * credential. It does not assert: compare the observations to the expected
 * behavior of the build under test.
 *
 *   WORKER_URL=http://localhost:8794 KILO_MCP_URL=http://localhost:8815/mcp \
 *     pnpm exec tsx services/cloud-agent-next/test/e2e/workspace-mcp-authority-local.ts
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { computeDatabaseUrl, createDrizzleClient, kilocode_users } from '@kilocode/db';
import { createMessageId } from '../../src/shared/message-id.js';
import { DRIVER_USER_EMAIL_SUFFIX, ensureTestUser, loadDevVars, loadRepoEnvFiles } from './auth.js';
import {
  DEFAULT_CONFIG,
  createWorktreeChat,
  deleteSession,
  fakeDirective,
  getMessageResult,
  sendMessage,
  trpcCall,
  type DriverConfig,
} from './client.js';
import {
  executeDockerCommand,
  findControlPlaneKiloRuntime,
  killOwnedControlPlanePrimary,
} from './sandbox-control.js';

const SERVICE_PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MCP_SERVER_NAME = 'kilo-cloud-agent';
const RECONNECT_WAIT_MS = 100_000;
const TURN_TIMEOUT_MS = 240_000;

type Chat = { cloudAgentSessionId: string; kiloSessionId: string };

function observe(step: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ step, at: new Date().toISOString(), ...data }));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTurn(config: DriverConfig, chat: Chat, messageId: string) {
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    let status = 'unavailable';
    try {
      status = (await getMessageResult(config, chat.cloudAgentSessionId, messageId)).status;
    } catch {
      // The result is not readable until admission completes.
    }
    if (status === 'completed' || status === 'failed' || status === 'interrupted') return status;
    if (Date.now() > deadline) return `timeout:${status}`;
    await sleep(2_000);
  }
}

async function sendTurn(config: DriverConfig, chat: Chat, label: string) {
  const messageId = createMessageId();
  try {
    await sendMessage(config, {
      cloudAgentSessionId: chat.cloudAgentSessionId,
      prompt: fakeDirective(`echo:${label}`),
      messageId,
    });
  } catch (error) {
    return { messageId, status: `rejected:${error instanceof Error ? error.message : 'error'}` };
  }
  return { messageId, status: await waitForTurn(config, chat, messageId) };
}

const inspectScript = String.raw`
  const fs = require('node:fs');
  const input = JSON.parse(process.argv[1]);
  const env = Object.fromEntries(fs.readFileSync('/proc/'+input.processId+'/environ','utf8').split('\0').filter(Boolean).map(item => { const at=item.indexOf('='); return [item.slice(0,at),item.slice(at+1)]; }));
  const headers = {Authorization:'Basic '+Buffer.from((env.KILO_SERVER_USERNAME || env.OPENCODE_SERVER_USERNAME || 'opencode')+':'+(env.KILO_SERVER_PASSWORD || env.OPENCODE_SERVER_PASSWORD)).toString('base64')};
  const query = '?directory='+encodeURIComponent(input.directory)+'&location[directory]='+encodeURIComponent(input.directory);
  const read = async endpoint => { const response=await fetch(input.serverUrl+endpoint+query,{headers}); if(!response.ok) return null; const body=await response.json(); return body && typeof body === 'object' && 'data' in body ? body.data : body; };
  const statusOf = async () => {
    const servers = (await read('/api/mcp')) ?? (await read('/mcp'));
    const list = Array.isArray(servers) ? servers : Object.entries(servers ?? {}).map(([name, value]) => ({ name, ...value }));
    return { list, entry: list.find(item => item.name === input.name) };
  };
  let { list, entry } = await statusOf();
  // Reconnect with the credential the runtime holds now, so a stale cached status cannot pass.
  let reconnected = null;
  if (entry && input.reconnect) {
    const post = async path => (await fetch(input.serverUrl + path + query, { method: 'POST', headers })).status;
    const name = encodeURIComponent(input.name);
    const disconnect = await post('/mcp/' + name + '/disconnect');
    const connect = await post('/mcp/' + name + '/connect');
    ({ list, entry } = await statusOf());
    reconnected = { disconnect, connect, status: entry ? (entry.status?.status ?? entry.status) : 'absent' };
  }
  const config = await read('/config') ?? await read('/api/config');
  let authorization = config?.mcp?.[input.name]?.headers?.Authorization;
  if (!authorization && env.KILO_CONFIG_CONTENT) {
    try { authorization = JSON.parse(env.KILO_CONFIG_CONTENT).mcp?.[input.name]?.headers?.Authorization; } catch {}
  }
  console.log(JSON.stringify({
    servers: list.map(item => item.name),
    status: entry ? (entry.status?.status ?? entry.status ?? 'present') : 'absent',
    authorization: authorization ?? null,
    reconnected,
    envHasEntry: Boolean(env.KILO_CONFIG_CONTENT && env.KILO_CONFIG_CONTENT.includes('"'+input.name+'"')),
  }));
`;

type McpListing = { httpStatus: number; tools?: number; error?: string };

async function mcpRequest(
  url: string,
  token: string,
  sessionId: string | null,
  body: Record<string, unknown>
): Promise<{ status: number; sessionId: string | null; message: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let message: unknown = null;
  const data = text
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .at(-1);
  try {
    message = JSON.parse(data ?? text);
  } catch {
    message = null;
  }
  return { status: response.status, sessionId: response.headers.get('mcp-session-id'), message };
}

/** A real MCP `initialize` + `tools/list` with the credential the runtime holds. */
async function listTools(url: string, token: string): Promise<McpListing> {
  const init = await mcpRequest(url, token, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'workspace-mcp-authority-local', version: '1' },
    },
  });
  if (init.status !== 200) return { httpStatus: init.status, error: 'initialize rejected' };
  await mcpRequest(url, token, init.sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  const listed = await mcpRequest(url, token, init.sessionId, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  });
  const tools = (listed.message as { result?: { tools?: unknown[] } } | null)?.result?.tools;
  return Array.isArray(tools)
    ? { httpStatus: listed.status, tools: tools.length }
    : { httpStatus: listed.status, error: 'tools/list returned no tools' };
}

async function callTool(url: string, token: string, name: string, args: Record<string, unknown>) {
  const init = await mcpRequest(url, token, null, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'workspace-mcp-authority-local', version: '1' },
    },
  });
  if (init.status !== 200) return { httpStatus: init.status, error: 'initialize rejected' };
  await mcpRequest(url, token, init.sessionId, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  const called = await mcpRequest(url, token, init.sessionId, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const message = called.message as {
    result?: { isError?: boolean; content?: unknown };
    error?: { message?: string };
  } | null;
  return {
    httpStatus: called.status,
    isError: message?.result?.isError === true || message?.error !== undefined,
    content: JSON.stringify(message?.result?.content ?? message?.error?.message ?? null).slice(
      0,
      240
    ),
  };
}

type Inspection = {
  runtime: boolean;
  status: string;
  reconnected?: unknown;
  servers?: string[];
  tokenExpiresAt?: string;
  authorizationIdSuffix?: string;
  listing?: McpListing;
  token?: string;
};

async function inspectMcp(chat: Chat, mcpUrl: string): Promise<Inspection> {
  const runtime = await findControlPlaneKiloRuntime(chat.kiloSessionId);
  if (!runtime) return { runtime: false, status: 'no-runtime' };
  const { stdout } = await executeDockerCommand([
    'exec',
    runtime.container.id,
    'bun',
    '-e',
    inspectScript,
    JSON.stringify({ ...runtime, name: MCP_SERVER_NAME, reconnect: true }),
  ]);
  const parsed = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
    servers: string[];
    status: string;
    authorization: string | null;
    reconnected: unknown;
  };
  const token = parsed.authorization?.replace(/^Bearer\s+/i, '');
  const claims = token ? (jwt.decode(token) as Record<string, unknown> | null) : null;
  const authority = claims?.cloudAgentAuthority as { authorizationId?: string } | undefined;
  return {
    runtime: true,
    status: parsed.status,
    servers: parsed.servers,
    reconnected: parsed.reconnected,
    ...(typeof claims?.exp === 'number'
      ? { tokenExpiresAt: new Date(claims.exp * 1000).toISOString() }
      : {}),
    ...(authority?.authorizationId
      ? { authorizationIdSuffix: authority.authorizationId.slice(-6) }
      : {}),
    ...(token ? { listing: await listTools(mcpUrl, token), token } : {}),
  };
}

function report(step: string, inspection: Inspection, extra: Record<string, unknown> = {}) {
  const { token: _token, ...visible } = inspection;
  observe(step, { ...visible, ...extra });
}

async function waitUntil(at: number, label: string): Promise<void> {
  const remaining = at - Date.now();
  if (remaining <= 0) return;
  observe('wait', { label, seconds: Math.round(remaining / 1000) });
  await sleep(remaining);
}

async function setPepper(databaseUrl: string, userId: string, pepper: string): Promise<void> {
  const driver = createDrizzleClient({
    connectionString: databaseUrl,
    poolConfig: { application_name: 'workspace-mcp-authority-local', max: 1 },
  });
  try {
    await driver.db
      .update(kilocode_users)
      .set({ api_token_pepper: pepper })
      .where(eq(kilocode_users.id, userId));
  } finally {
    await driver.pool.end().catch(() => {});
  }
}

async function main(): Promise<void> {
  loadRepoEnvFiles(SERVICE_PACKAGE_DIR);
  const devVars = loadDevVars(SERVICE_PACKAGE_DIR);
  const lifetimeMs = Number(devVars.RUNTIME_AUTHORIZATION_LIFETIME_MS ?? '0');
  if (!Number.isInteger(lifetimeMs) || lifetimeMs < 240_000) {
    throw new Error('Set RUNTIME_AUTHORIZATION_LIFETIME_MS >= 240000 in the local .dev.vars');
  }
  const scenario = new Set((process.env.WORKSPACE_MCP_STEPS ?? 'expiry,restart').split(','));
  const mcpUrl = process.env.KILO_MCP_URL ?? 'http://localhost:8815/mcp';
  const databaseUrl = process.env.DATABASE_URL ?? computeDatabaseUrl();
  const email = `kilo-e2e-workspace-mcp-${Date.now()}${DRIVER_USER_EMAIL_SUFFIX}`;
  const user = await ensureTestUser(databaseUrl, email, { funded: true });
  const config: DriverConfig = {
    ...DEFAULT_CONFIG,
    user,
    nextAuthSecret: devVars.NEXTAUTH_SECRET ?? '',
    internalApiSecret: devVars.INTERNAL_API_SECRET,
    workerUrl: process.env.WORKER_URL ?? DEFAULT_CONFIG.workerUrl,
    fakeLlmUrl: process.env.FAKE_LLM_URL ?? DEFAULT_CONFIG.fakeLlmUrl,
    expectControlPlane: true,
  };
  observe('start', { lifetimeSeconds: lifetimeMs / 1000, steps: [...scenario] });

  const rootMessageId = createMessageId();
  const rootCreatedAt = Date.now();
  const root = await trpcCall<Chat & { worktreeId?: string }>(
    config,
    'prepareSession',
    {
      prompt: fakeDirective('echo:root-ready'),
      mode: 'code',
      model: config.model,
      gitUrl: config.gitUrl,
      shallow: true,
      createdOnPlatform: 'cloud-agent-web',
      clientProvenance: 'browser',
      autoInitiate: true,
      autoCommit: false,
      operationKey: randomUUID(),
      initialMessageId: rootMessageId,
    },
    { internalApiSecret: config.internalApiSecret }
  );
  observe('root-created', {
    worktree: Boolean(root.worktreeId),
    rootTurn: await waitForTurn(config, root, rootMessageId),
  });
  report('root-mcp', await inspectMcp(root, mcpUrl));

  if (scenario.has('expiry')) {
    await waitUntil(
      rootCreatedAt + lifetimeMs - 120_000,
      'create the sibling shortly before root expiry'
    );
  }
  const sibling = await createWorktreeChat(config, {
    sourceKiloSessionId: root.kiloSessionId,
    sourceCloudAgentSessionId: root.cloudAgentSessionId,
    operationKey: randomUUID(),
  });
  observe('sibling-created', { turn: await sendTurn(config, sibling, 'sibling-ready') });
  report('sibling-mcp-before-root-expiry', await inspectMcp(sibling, mcpUrl));

  if (scenario.has('expiry')) {
    await waitUntil(rootCreatedAt + lifetimeMs + 15_000, 'root delegation expiry');
    observe('sibling-send-after-root-expiry', {
      turn: await sendTurn(config, sibling, 'after-root-expiry'),
    });
    report('sibling-mcp-after-root-expiry', await inspectMcp(sibling, mcpUrl));
  }

  if (scenario.has('restart')) {
    const runtime = await findControlPlaneKiloRuntime(sibling.kiloSessionId);
    const killed = runtime
      ? await killOwnedControlPlanePrimary(runtime.container, sibling.kiloSessionId)
      : [];
    observe('sandbox-killed', { killed: killed.length });
    await sleep(RECONNECT_WAIT_MS);
    observe('sibling-send-after-restart', {
      turn: await sendTurn(config, sibling, 'after-restart'),
    });
    report('sibling-mcp-after-restart', await inspectMcp(sibling, mcpUrl));
  }

  if (scenario.has('delete-root')) {
    await deleteSession(config, root.cloudAgentSessionId);
    observe('root-deleted', {});
    observe('sibling-send-after-root-delete', {
      turn: await sendTurn(config, sibling, 'after-root-delete'),
    });
    const inspection = await inspectMcp(sibling, mcpUrl);
    report('sibling-mcp-after-root-delete', inspection, {
      ...(inspection.token
        ? { listChildren: await callTool(mcpUrl, inspection.token, 'list_child_sessions', {}) }
        : {}),
    });
  }

  if (scenario.has('revoke')) {
    const inspection = await inspectMcp(sibling, mcpUrl);
    const token = inspection.token;
    if (token) {
      observe('mcp-before-revocation', {
        listChildren: await callTool(mcpUrl, token, 'list_child_sessions', {}),
      });
    }
    const authority = token
      ? ((jwt.decode(token) as Record<string, unknown> | null)?.cloudAgentAuthority as
          | { expiresAt: number }
          | undefined)
      : undefined;
    const originalPepper = user.api_token_pepper ?? '';
    const rotatedPepper = `${originalPepper}-rotated`;
    await setPepper(databaseUrl, user.id, rotatedPepper);
    observe('pepper-rotated', {});
    if (authority) {
      // The control token the web app would mint for this authority after the
      // rotation. The Worker accepts its current pepper; the workspace's live
      // binding check must not.
      const now = Math.floor(Date.now() / 1000);
      const scoped = jwt.sign(
        {
          env: 'development',
          kiloUserId: user.id,
          apiTokenPepper: rotatedPepper,
          version: 3,
          aud: 'cloud-agent-next',
          tokenPurpose: 'delegated-workload',
          credentialExchange: false,
          cloudAgentAuthority: authority,
          iat: now,
          exp: authority.expiresAt,
        },
        config.nextAuthSecret ?? '',
        { algorithm: 'HS256' }
      );
      const response = await fetch(
        `${config.workerUrl}/trpc/listChildSessions?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`,
        { headers: { Authorization: `Bearer ${scoped}` } }
      );
      observe('scoped-management-with-rotated-pepper', { httpStatus: response.status });
    }
    await setPepper(databaseUrl, user.id, originalPepper);
    observe('pepper-restored', {});
    if (token) {
      observe('stale-token-after-revocation', {
        listChildren: await callTool(mcpUrl, token, 'list_child_sessions', {}),
      });
    }
    const second = await createWorktreeChat(config, {
      sourceKiloSessionId: sibling.kiloSessionId,
      sourceCloudAgentSessionId: sibling.cloudAgentSessionId,
      operationKey: randomUUID(),
    }).catch((error: unknown) => {
      observe('second-sibling-rejected', {
        error: error instanceof Error ? error.message.slice(0, 160) : 'error',
      });
      return null;
    });
    if (second) {
      observe('second-sibling-created', { turn: await sendTurn(config, second, 'after-revoke') });
      report('second-sibling-mcp-after-revocation', await inspectMcp(second, mcpUrl));
    }
  }
  observe('done', {
    root: root.cloudAgentSessionId.slice(-6),
    sibling: sibling.cloudAgentSessionId.slice(-6),
  });
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
