/**
 * Local-only check of the built-in `kilo-cloud-agent` MCP connection across
 * the lifetime of a two-chat workspace. It drives the real Worker, Durable
 * Objects, sandbox, wrapper, Kilo runtime and local kilo-mcp with synthetic
 * identities and fake inference.
 *
 * The local Worker must run with `RUNTIME_AUTHORIZATION_LIFETIME_MS` in its
 * `.dev.vars` (for example 480000), so a runtime delegation expires within the
 * run. The script prints one JSON observation per step and never prints a
 * credential. Use WORKSPACE_MCP_STEPS=children to assert nested launch and
 * management behavior on a local public repository.
 *
 *   WORKER_URL=http://localhost:8794 KILO_MCP_URL=http://localhost:8815/mcp \
 *     pnpm exec tsx services/cloud-agent-next/test/e2e/workspace-mcp-authority-local.ts
 */
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
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

async function requestTool(
  url: string,
  token: string,
  name: string,
  args: Record<string, unknown>
) {
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
    content: message?.result?.content ?? message?.error?.message ?? null,
  };
}

async function callTool(url: string, token: string, name: string, args: Record<string, unknown>) {
  const { content, ...status } = await requestTool(url, token, name, args);
  return { ...status, content: JSON.stringify(content ?? null).slice(0, 240) };
}

const childSchema = z.object({
  cloudAgentSessionId: z.string(),
  kiloSessionId: z.string(),
  worktreeId: z.string(),
});

async function toolData(url: string, token: string, name: string, args: Record<string, unknown>) {
  const result = await requestTool(url, token, name, args);
  assert.equal(result.httpStatus, 200, `${name}: MCP request failed`);
  assert.ok(
    !result.isError,
    `${name}: ${typeof result.content === 'string' ? result.content : 'MCP tool failed'}`
  );
  const [part] = z
    .array(z.object({ type: z.literal('text'), text: z.string() }))
    .min(1)
    .parse(result.content);
  assert.ok(part);
  return JSON.parse(part.text) as unknown;
}

async function exerciseChildren(config: DriverConfig, mcpUrl: string, root: Chat, token: string) {
  const task = {
    publicRepoUrl: config.gitUrl,
    mode: 'code',
    model: config.model,
    autoCommit: false,
  };
  const child = childSchema.parse(
    await toolData(mcpUrl, token, 'spawn_session', {
      ...task,
      operationKey: randomUUID(),
      prompt: fakeDirective('echo:manual-child-ready'),
    })
  );
  assert.equal(
    await waitForTurn(config, child, await initialMessage(mcpUrl, token, child)),
    'completed'
  );
  const transcript = await toolData(mcpUrl, token, 'get_session_messages', {
    sessionId: child.cloudAgentSessionId,
  });
  assert.ok(JSON.stringify(transcript).includes('manual-child-ready'));
  observe('child-transcript', { result: 'passed' });
  const artifacts = await toolData(mcpUrl, token, 'list_child_artifacts', {
    cloudAgentSessionId: child.cloudAgentSessionId,
  });
  assert.deepEqual(z.object({ entries: z.array(z.unknown()) }).parse(artifacts).entries, []);
  observe('child-artifact-list', { result: 'passed' });

  const childMcp = await inspectMcp(child, mcpUrl);
  assert.ok(childMcp.token, 'child MCP credential unavailable');
  const grandchild = childSchema.parse(
    await toolData(mcpUrl, childMcp.token, 'spawn_session', {
      ...task,
      operationKey: randomUUID(),
      prompt: fakeDirective('echo:manual-grandchild-ready'),
      callbackTarget: { url: `workspace:${child.cloudAgentSessionId}` },
    })
  );
  assert.equal(
    await waitForTurn(config, grandchild, await initialMessage(mcpUrl, childMcp.token, grandchild)),
    'completed'
  );
  const denied = await requestTool(mcpUrl, token, 'get_session_messages', {
    sessionId: grandchild.cloudAgentSessionId,
  });
  assert.ok(denied.isError, 'root must not read a grandchild');
  const listed = await toolData(mcpUrl, childMcp.token, 'list_child_sessions', {});
  assert.ok(JSON.stringify(listed).includes(grandchild.cloudAgentSessionId));
  observe('grandchild-lineage', { result: 'passed' });

  const callbackDeadline = Date.now() + 30_000;
  let callbackSeen = false;
  while (Date.now() < callbackDeadline) {
    const page = await toolData(mcpUrl, token, 'get_session_messages', {
      sessionId: child.cloudAgentSessionId,
    });
    if (JSON.stringify(page).includes('manual-grandchild-ready')) {
      callbackSeen = true;
      break;
    }
    await sleep(2_000);
  }
  assert.ok(callbackSeen, 'grandchild callback did not appear in its parent chat');
  observe('grandchild-callback', { result: 'passed' });

  const sibling = childSchema.parse(
    await toolData(mcpUrl, token, 'create_child_chat', {
      cloudAgentSessionId: child.cloudAgentSessionId,
      operationKey: randomUUID(),
    })
  );
  assert.equal(sibling.worktreeId, child.worktreeId);
  const { messageId } = z
    .object({ messageId: z.string() })
    .parse(await toolData(mcpUrl, token, 'generate_message_id', {}));
  await toolData(mcpUrl, token, 'send_message', {
    cloudAgentSessionId: sibling.cloudAgentSessionId,
    messageId,
    payload: {
      type: 'prompt',
      prompt: fakeDirective('echo:manual-child-chat'),
      mode: 'code',
      model: config.model,
    },
  });
  assert.equal(await waitForTurn(config, sibling, messageId), 'completed');
  const hidden = await requestTool(mcpUrl, token, 'search', { query: 'sessions' });
  assert.ok(hidden.isError, 'scoped MCP must reject the hidden search tool');
  const self = await requestTool(mcpUrl, token, 'get_session', {
    cloudAgentSessionId: root.cloudAgentSessionId,
  });
  assert.ok(self.isError, 'scoped MCP must reject management of its own session');
  observe('child-chat-and-refusals', { result: 'passed' });
}

async function initialMessage(url: string, token: string, child: Chat): Promise<string> {
  const { sessions } = z
    .object({
      sessions: z.array(
        z.object({ cloudAgentSessionId: z.string(), initialMessageId: z.string().optional() })
      ),
    })
    .parse(await toolData(url, token, 'list_child_sessions', {}));
  const messageId = sessions.find(
    session => session.cloudAgentSessionId === child.cloudAgentSessionId
  )?.initialMessageId;
  assert.ok(messageId, 'child registry did not return the initial message ID');
  return messageId;
}

async function exerciseQuestions(config: DriverConfig, url: string, root: Chat, token: string) {
  const child = childSchema.parse(
    await toolData(url, token, 'spawn_session', {
      publicRepoUrl: config.gitUrl,
      mode: 'code',
      model: config.model,
      operationKey: randomUUID(),
      prompt: fakeDirective(`question:${randomUUID()}:Continue the local manual test?`),
      callbackTarget: { url: `workspace:${root.cloudAgentSessionId}` },
    })
  );
  const initialMessageId = await initialMessage(url, token, child);
  const pendingSchema = z.object({ questions: z.array(z.object({ id: z.string() })) });
  const deadline = Date.now() + 80_000;
  let questionId: string | undefined;
  while (Date.now() < deadline) {
    const { questions } = pendingSchema.parse(
      await toolData(url, token, 'get_pending_questions', {
        cloudAgentSessionId: child.cloudAgentSessionId,
      })
    );
    questionId = questions[0]?.id;
    if (questionId) break;
    const result = await getMessageResult(config, child.cloudAgentSessionId, initialMessageId);
    assert.ok(
      !['completed', 'failed', 'interrupted'].includes(result.status),
      `Child turn settled before asking: ${result.status}`
    );
    await sleep(2_000);
  }
  assert.ok(questionId, 'child question did not become pending');

  const callbackDeadline = Date.now() + 25_000;
  let sawCallback = false;
  while (Date.now() < callbackDeadline) {
    const page = await trpcCall(
      config,
      'getSessionMessagesPage',
      { sessionId: root.cloudAgentSessionId, limit: 5 },
      { method: 'GET' }
    );
    if (JSON.stringify(page).includes(questionId)) {
      sawCallback = true;
      break;
    }
    await sleep(2_000);
  }
  assert.ok(sawCallback, 'question callback did not reach the parent transcript');
  assert.deepEqual(
    await toolData(url, token, 'answer_question', {
      sessionId: child.cloudAgentSessionId,
      questionId,
      answers: [['Continue']],
    }),
    { success: true }
  );
  assert.equal(await waitForTurn(config, child, initialMessageId), 'completed');
  observe('question-callback-and-answer', { result: 'passed' });
}

async function exerciseQueuedCancellation(config: DriverConfig, url: string, token: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const child = childSchema.parse(
      await toolData(url, token, 'spawn_session', {
        publicRepoUrl: config.gitUrl,
        model: config.model,
        mode: 'code',
        operationKey: randomUUID(),
        prompt: fakeDirective('echo:queue-cancel-check'),
      })
    );
    const messageId = await initialMessage(url, token, child);
    const cancelInput = { sessionId: child.cloudAgentSessionId, messageId };
    const cancelled = z
      .object({ dropped: z.boolean() })
      .parse(await toolData(url, token, 'cancel_queued_message', cancelInput));
    assert.equal(
      await waitForTurn(config, child, messageId),
      cancelled.dropped ? 'interrupted' : 'completed'
    );
    if (!cancelled.dropped) continue;
    assert.deepEqual(await toolData(url, token, 'cancel_queued_message', cancelInput), {
      dropped: false,
    });
    observe('queued-message-cancel', { result: 'passed', attempt });
    return;
  }
  assert.fail('Cancellation did not drop a queued message in three cold launches');
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
  const rootTurn = await waitForTurn(config, root, rootMessageId);
  observe('root-created', {
    worktree: Boolean(root.worktreeId),
    rootTurn,
  });
  assert.equal(rootTurn, 'completed');
  const rootMcp = await inspectMcp(root, mcpUrl);
  report('root-mcp', rootMcp);
  assert.equal(rootMcp.status, 'connected');
  assert.equal(rootMcp.listing?.httpStatus, 200);
  if (scenario.has('discovery')) {
    assert.ok(rootMcp.token, 'root MCP credential unavailable');
    for (const platform of ['github', 'gitlab']) {
      const result = await toolData(mcpUrl, rootMcp.token, 'list_repositories', { platform });
      z.object({ repositories: z.array(z.unknown()), integrationInstalled: z.boolean() }).parse(
        result
      );
    }
    const branchResult = await requestTool(mcpUrl, rootMcp.token, 'list_branches', {
      platform: 'bitbucket',
      repository: { fullName: 'example/repo' },
    });
    assert.ok(branchResult.isError);
    assert.match(JSON.stringify(branchResult.content), /Bitbucket.*organization/i);
    observe('repository-discovery', { result: 'passed' });
  }
  if (scenario.has('children')) {
    assert.ok(rootMcp.token, 'root MCP credential unavailable');
    await exerciseChildren(config, mcpUrl, root, rootMcp.token);
  }
  if (scenario.has('questions')) {
    assert.ok(rootMcp.token, 'root MCP credential unavailable');
    await exerciseQuestions(config, mcpUrl, root, rootMcp.token);
  }
  if (scenario.has('queue')) {
    assert.ok(rootMcp.token, 'root MCP credential unavailable');
    await exerciseQueuedCancellation(config, mcpUrl, rootMcp.token);
  }

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
  const siblingTurn = await sendTurn(config, sibling, 'sibling-ready');
  observe('sibling-created', { turn: siblingTurn });
  assert.equal(siblingTurn.status, 'completed');
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
