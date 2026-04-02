import { Hono } from 'hono';
import { z } from 'zod';
import { runAgent, resolveGitCredentials } from './agent-runner';
import {
  stopAgent,
  sendMessage,
  updateAgentModel,
  getAgentStatus,
  activeAgentCount,
  activeServerCount,
  getUptime,
  stopAll,
  drainAll,
  isDraining,
  getAgentEvents,
  registerEventSink,
} from './process-manager';
import { startHeartbeat, stopHeartbeat, notifyContainerReady } from './heartbeat';
import { pushContext as pushDashboardContext } from './dashboard-context';
import { mergeBranch, setupRigBrowseWorktree } from './git-manager';
import {
  StartAgentRequest,
  SendMessageRequest,
  UpdateAgentModelRequest,
  MergeRequest,
  SetupRepoRequest,
} from './types';
import type {
  AgentStatusResponse,
  HealthResponse,
  StreamTicketResponse,
  MergeResult,
} from './types';

const MAX_TICKETS = 1000;
const streamTickets = new Map<string, { agentId: string; expiresAt: number }>();

// Minimal Zod schema for the town config delivered via X-Town-Config header.
// Uses z.record() so any string-keyed object is accepted and future keys are preserved.
const TownConfigHeader = z.record(z.string(), z.unknown());

// Last-known-good town config. Updated on every request that carries the header.
// Used as a fallback by code that runs outside a request context (e.g. background tasks).
let lastKnownTownConfig: Record<string, unknown> | null = null;

/** Get the latest town config delivered via X-Town-Config header. */
export function getCurrentTownConfig(): Record<string, unknown> | null {
  return lastKnownTownConfig;
}

/**
 * Sync config-derived env vars from the last-known town config into
 * process.env. Safe to call at any time — no-ops when no config is cached.
 */
function syncTownConfigToProcessEnv(): void {
  const cfg = getCurrentTownConfig();
  if (!cfg) return;

  const CONFIG_ENV_MAP: Array<[string, string]> = [
    ['github_cli_pat', 'GITHUB_CLI_PAT'],
    ['git_author_name', 'GASTOWN_GIT_AUTHOR_NAME'],
    ['git_author_email', 'GASTOWN_GIT_AUTHOR_EMAIL'],
    ['kilocode_token', 'KILOCODE_TOKEN'],
  ];
  for (const [cfgKey, envKey] of CONFIG_ENV_MAP) {
    const val = cfg[cfgKey];
    if (typeof val === 'string' && val) {
      process.env[envKey] = val;
    } else {
      delete process.env[envKey];
    }
  }

  const gitAuth = cfg.git_auth;
  if (typeof gitAuth === 'object' && gitAuth !== null) {
    const auth = gitAuth as Record<string, unknown>;
    for (const [authKey, envKey] of [
      ['github_token', 'GIT_TOKEN'],
      ['gitlab_token', 'GITLAB_TOKEN'],
      ['gitlab_instance_url', 'GITLAB_INSTANCE_URL'],
    ] as const) {
      const val = auth[authKey];
      if (typeof val === 'string' && val) {
        process.env[envKey] = val;
      } else {
        delete process.env[envKey];
      }
    }
  }

  if (cfg.disable_ai_coauthor) {
    process.env.GASTOWN_DISABLE_AI_COAUTHOR = '1';
  } else {
    delete process.env.GASTOWN_DISABLE_AI_COAUTHOR;
  }
}

export const app = new Hono();

// Parse and validate town config from X-Town-Config header (sent by TownDO on
// every request). The validated config is stored in a module-level cache
// accessible via getCurrentTownConfig().
app.use('*', async (c, next) => {
  const configHeader = c.req.header('X-Town-Config');
  if (configHeader) {
    try {
      const raw: unknown = JSON.parse(configHeader);
      const result = TownConfigHeader.safeParse(raw);
      if (result.success) {
        lastKnownTownConfig = result.data;
        const hasToken =
          typeof result.data.kilocode_token === 'string' && result.data.kilocode_token.length > 0;
        console.log(
          `[control-server] X-Town-Config received: hasKilocodeToken=${hasToken} keys=${Object.keys(result.data).join(',')}`
        );
      } else {
        console.warn(
          '[control-server] X-Town-Config header failed validation:',
          result.error.issues
        );
      }
    } catch {
      console.warn('[control-server] X-Town-Config header malformed (invalid JSON)');
    }
  }
  await next();
});

// Log method, path, status, and duration for every request
app.use('*', async (c, next) => {
  const start = performance.now();
  const method = c.req.method;
  const path = c.req.path;
  console.log(`[control-server] --> ${method} ${path}`);
  await next();
  const duration = (performance.now() - start).toFixed(1);
  const status = c.res.status;
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'log';
  console[level](`[control-server] <-- ${method} ${path} ${status} ${duration}ms`);
});

// GET /health
app.get('/health', c => {
  // When the TownDO is draining, it passes the drain nonce and town
  // ID via headers so idle containers (no running agents) can
  // acknowledge readiness and clear the drain flag.
  const drainNonce = c.req.header('X-Drain-Nonce');
  const townId = c.req.header('X-Town-Id');
  if (drainNonce && townId) {
    void notifyContainerReady(townId, drainNonce);
  }

  const response: HealthResponse = {
    status: 'ok',
    agents: activeAgentCount(),
    servers: activeServerCount(),
    uptime: getUptime(),
    draining: isDraining() || undefined,
  };
  return c.json(response);
});

// POST /dashboard-context
// Receives a dashboard context snapshot pushed from the TownDO.
// Stored in-memory for the plugin to read on each LLM call — no
// network round-trip needed at prompt time.
app.post('/dashboard-context', async c => {
  const body: unknown = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body !== 'object' ||
    !('context' in body) ||
    typeof body.context !== 'string'
  ) {
    return c.json({ error: 'Missing or invalid context field' }, 400);
  }
  pushDashboardContext(body.context);
  return c.json({ pushed: true });
});

// POST /refresh-token
// Hot-swap the container-scoped JWT on the running process. Called by
// the TownDO alarm to push a fresh token before the current one expires.
// Updates process.env so all subsequent API calls use the new token.
app.post('/refresh-token', async c => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string') {
    return c.json({ error: 'Missing or invalid token field' }, 400);
  }
  process.env.GASTOWN_CONTAINER_TOKEN = body.token;
  console.log('[control-server] Container token refreshed');
  return c.json({ refreshed: true });
});

// POST /sync-config
// Push config-derived env vars from X-Town-Config into process.env on
// the running container. Called by TownDO.syncConfigToContainer() after
// persisting env vars to DO storage, so the live process picks up
// changes (e.g. refreshed KILOCODE_TOKEN) without a container restart.
app.post('/sync-config', async c => {
  syncTownConfigToProcessEnv();
  return c.json({ synced: true });
});

// POST /agents/start
app.post('/agents/start', async c => {
  if (isDraining()) {
    console.warn('[control-server] /agents/start: rejected — container is draining');
    return c.json({ error: 'Container is draining, cannot start new agents' }, 503);
  }

  const body: unknown = await c.req.json().catch(() => null);
  const parsed = StartAgentRequest.safeParse(body);
  if (!parsed.success) {
    console.error('[control-server] /agents/start: invalid request body', parsed.error.issues);
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  console.log(
    `[control-server] /agents/start: role=${parsed.data.role} name=${parsed.data.name} rigId=${parsed.data.rigId} agentId=${parsed.data.agentId}`
  );
  console.log(`[control-server] system prompt length: ${parsed.data.systemPrompt?.length ?? 0}`);

  try {
    const agent = await runAgent(parsed.data);
    console.log(
      `[control-server] /agents/start: success agentId=${agent.agentId} port=${agent.serverPort} session=${agent.sessionId}`
    );
    // Strip sensitive fields before returning — the caller only needs
    // agent metadata, not the internal tokens or API URL.
    const {
      gastownSessionToken: _,
      gastownContainerToken: _ct,
      gastownApiUrl: _url,
      ...safeAgent
    } = agent;
    return c.json(safeAgent, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[control-server] /agents/start: FAILED for ${parsed.data.name}: ${message}`);
    return c.json({ error: message }, 500);
  }
});

// POST /agents/:agentId/stop
app.post('/agents/:agentId/stop', async c => {
  const { agentId } = c.req.param();
  if (!getAgentStatus(agentId)) {
    return c.json({ error: `Agent ${agentId} not found` }, 404);
  }
  // StopAgentRequest.signal is no longer used — abort is always clean via API.
  // We still parse the body to avoid breaking callers that send it.
  await c.req.json().catch(() => ({}));

  await stopAgent(agentId);
  return c.json({ stopped: true });
});

// POST /agents/:agentId/message
app.post('/agents/:agentId/message', async c => {
  const { agentId } = c.req.param();
  if (!getAgentStatus(agentId)) {
    return c.json({ error: `Agent ${agentId} not found` }, 404);
  }
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = SendMessageRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  await sendMessage(agentId, parsed.data.prompt);
  return c.json({ sent: true });
});

// PATCH /agents/:agentId/model
// Hot-update the model for a running agent without restarting the session.
app.patch('/agents/:agentId/model', async c => {
  const { agentId } = c.req.param();
  if (!getAgentStatus(agentId)) {
    return c.json({ error: `Agent ${agentId} not found` }, 404);
  }
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = UpdateAgentModelRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  // Sync config-derived env vars from X-Town-Config into process.env so
  // the SDK server restart picks up fresh tokens and git identity.
  // The middleware already parsed the header into lastKnownTownConfig.
  syncTownConfigToProcessEnv();

  await updateAgentModel(
    agentId,
    parsed.data.model,
    parsed.data.smallModel,
    parsed.data.conversationHistory
  );
  return c.json({ updated: true });
});

// GET /agents/:agentId/status
app.get('/agents/:agentId/status', c => {
  const { agentId } = c.req.param();
  const agent = getAgentStatus(agentId);
  if (!agent) {
    return c.json({ error: `Agent ${agentId} not found` }, 404);
  }

  const response: AgentStatusResponse = {
    agentId: agent.agentId,
    status: agent.status,
    serverPort: agent.serverPort,
    sessionId: agent.sessionId,
    startedAt: agent.startedAt,
    lastActivityAt: agent.lastActivityAt,
    activeTools: agent.activeTools,
    messageCount: agent.messageCount,
    exitReason: agent.exitReason,
  };
  return c.json(response);
});

// GET /agents/:agentId/events?after=N
// Returns buffered events for the agent, optionally after a given event id.
// Used by the TownContainerDO to poll for events and relay them to WebSocket clients.
// Does NOT 404 for unknown agents — returns an empty array so the poller
// can keep trying while the agent is starting up.
app.get('/agents/:agentId/events', c => {
  const { agentId } = c.req.param();
  const afterParam = c.req.query('after');
  const parsed = afterParam !== undefined ? Number(afterParam) : 0;
  const afterId = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  const events = getAgentEvents(agentId, afterId);
  return c.json({ events });
});

// POST /agents/:agentId/stream-ticket
// Issues a one-time-use stream ticket for the agent. Does NOT require
// the agent to be registered yet — tickets can be issued optimistically
// so the frontend can connect a WebSocket before the agent finishes starting.
app.post('/agents/:agentId/stream-ticket', c => {
  const { agentId } = c.req.param();

  const ticket = crypto.randomUUID();
  const expiresAt = Date.now() + 60_000;
  streamTickets.set(ticket, { agentId, expiresAt });

  // Clean up expired tickets and enforce cap
  for (const [t, v] of streamTickets) {
    if (v.expiresAt < Date.now()) streamTickets.delete(t);
  }
  if (streamTickets.size > MAX_TICKETS) {
    const oldest = streamTickets.keys().next().value;
    if (oldest) streamTickets.delete(oldest);
  }

  const response: StreamTicketResponse = {
    ticket,
    expiresAt: new Date(expiresAt).toISOString(),
  };
  return c.json(response);
});

/**
 * Validate a stream ticket and return the associated agentId, consuming it.
 * Returns null if the ticket is invalid or expired.
 */
export function consumeStreamTicket(ticket: string): string | null {
  const entry = streamTickets.get(ticket);
  if (!entry) return null;
  streamTickets.delete(ticket);
  if (entry.expiresAt < Date.now()) return null;
  return entry.agentId;
}

// POST /repos/setup
// Proactively clone a rig's repo and create a browse worktree so the
// mayor (and future agents) have immediate access to the codebase.
// Called by the TownDO when a new rig is added.
app.post('/repos/setup', async c => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = SetupRepoRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  const req = parsed.data;
  console.log(`[control-server] /repos/setup: rigId=${req.rigId} gitUrl=${req.gitUrl}`);

  // Run in background so we return 202 immediately.
  // Errors are caught and logged — never propagated as unhandled rejections.
  const doSetup = async () => {
    try {
      // Resolve git credentials from platformIntegrationId if no token
      // is present in envVars (e.g. rigs using GitHub App installations).
      const envVars = await resolveGitCredentials({
        envVars: req.envVars,
        platformIntegrationId: req.platformIntegrationId,
      });

      const hasGitToken = !!(envVars.GIT_TOKEN || envVars.GITHUB_TOKEN || envVars.GITLAB_TOKEN);
      console.log(
        `[control-server] /repos/setup: cloning rigId=${req.rigId} hasGitToken=${hasGitToken} hasPlatformIntegration=${!!req.platformIntegrationId}`
      );

      const browseDir = await setupRigBrowseWorktree({
        rigId: req.rigId,
        gitUrl: req.gitUrl,
        defaultBranch: req.defaultBranch,
        envVars,
      });
      console.log(`[control-server] /repos/setup: done rigId=${req.rigId} browse=${browseDir}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(
        `[control-server] /repos/setup: FAILED rigId=${req.rigId} gitUrl=${req.gitUrl}: ${message}`,
        stack ? `\n${stack}` : ''
      );
    }
  };
  doSetup().catch(err => {
    console.error(`[control-server] /repos/setup: unhandled error rigId=${req.rigId}:`, err);
  });

  return c.json({ status: 'accepted', message: 'Repo setup started' }, 202);
});

// POST /git/merge
// Deterministic merge of a polecat branch into the target branch.
// Called by the Rig DO's processReviewQueue → startMergeInContainer.
// Runs the merge synchronously and reports the result back to the Rig DO
// via a callback to the completeReview endpoint.
app.post('/git/merge', async c => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = MergeRequest.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request body', issues: parsed.error.issues }, 400);
  }

  const req = parsed.data;

  // Run the merge in the background so we can return 202 immediately.
  // The Rig DO will be notified via callback when the merge completes.
  const apiUrl = req.envVars?.GASTOWN_API_URL ?? process.env.GASTOWN_API_URL;
  // Prefer container secret (no expiry) over session token (8h JWT)
  const token =
    req.envVars?.GASTOWN_CONTAINER_TOKEN ??
    process.env.GASTOWN_CONTAINER_TOKEN ??
    req.envVars?.GASTOWN_SESSION_TOKEN ??
    process.env.GASTOWN_SESSION_TOKEN;

  const doMerge = async () => {
    const outcome = await mergeBranch({
      rigId: req.rigId,
      branch: req.branch,
      targetBranch: req.targetBranch,
      gitUrl: req.gitUrl,
      envVars: req.envVars,
    });

    // Report result back to the Rig DO
    const callbackUrl =
      req.callbackUrl ??
      (apiUrl
        ? `${apiUrl}/api/towns/${req.townId}/rigs/${req.rigId}/review-queue/${req.entryId}/complete`
        : null);

    if (callbackUrl && token) {
      try {
        const resp = await fetch(callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            entry_id: req.entryId,
            status: outcome.status,
            message: outcome.message,
            commit_sha: outcome.commitSha,
          }),
        });
        if (!resp.ok) {
          console.warn(
            `Merge callback failed for entry ${req.entryId}: ${resp.status} ${resp.statusText}`
          );
        }
      } catch (err) {
        console.warn(`Merge callback error for entry ${req.entryId}:`, err);
      }
    } else {
      console.warn(
        `No callback URL or token for merge entry ${req.entryId}, result: ${outcome.status}`
      );
    }
  };

  // Fire and forget — the Rig DO will time out stuck entries via recoverStuckReviews
  doMerge().catch(err => {
    console.error(`Merge failed for entry ${req.entryId}:`, err);
  });

  const result: MergeResult = { status: 'accepted', message: 'Merge started' };
  return c.json(result, 202);
});

// GET /agents/:agentId/pending-nudges
// Proxies to the gastown worker to fetch undelivered nudges for an agent.
// Called by the process-manager when the agent goes idle.
app.get('/agents/:agentId/pending-nudges', async c => {
  const { agentId } = c.req.param();
  const apiUrl = process.env.GASTOWN_API_URL;
  const token = process.env.GASTOWN_CONTAINER_TOKEN ?? process.env.GASTOWN_SESSION_TOKEN;
  const townId = process.env.GASTOWN_TOWN_ID;
  const rigId = process.env.GASTOWN_RIG_ID;

  if (!apiUrl || !token || !townId || !rigId) {
    return c.json({ error: 'Missing gastown configuration' }, 503);
  }

  try {
    const resp = await fetch(
      `${apiUrl}/api/towns/${townId}/rigs/${rigId}/agents/${agentId}/pending-nudges`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Gastown-Agent-Id': agentId,
          'X-Gastown-Rig-Id': rigId,
        },
      }
    );
    const body: unknown = await resp.json();
    return c.json(body, resp.status as 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// POST /agents/:agentId/nudge-delivered
// Marks a nudge as delivered via the gastown worker.
// Body: { nudge_id: string }
app.post('/agents/:agentId/nudge-delivered', async c => {
  const { agentId } = c.req.param();
  const apiUrl = process.env.GASTOWN_API_URL;
  const token = process.env.GASTOWN_CONTAINER_TOKEN ?? process.env.GASTOWN_SESSION_TOKEN;
  const townId = process.env.GASTOWN_TOWN_ID;
  const rigId = process.env.GASTOWN_RIG_ID;

  if (!apiUrl || !token || !townId || !rigId) {
    return c.json({ error: 'Missing gastown configuration' }, 503);
  }

  const body: unknown = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body !== 'object' ||
    !('nudge_id' in body) ||
    typeof body.nudge_id !== 'string'
  ) {
    return c.json({ error: 'Missing or invalid nudge_id field' }, 400);
  }

  try {
    const resp = await fetch(
      `${apiUrl}/api/towns/${townId}/rigs/${rigId}/agents/${agentId}/nudge-delivered`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'X-Gastown-Agent-Id': agentId,
          'X-Gastown-Rig-Id': rigId,
        },
        body: JSON.stringify({ nudge_id: body.nudge_id }),
      }
    );
    const respBody: unknown = await resp.json();
    return c.json(respBody, resp.status as 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 500);
  }
});

// ── PTY proxy routes ──────────────────────────────────────────────────
// Proxy PTY operations to the agent's internal SDK server.
// The SDK server (kilo serve) exposes /pty/* routes on 127.0.0.1:<port>.

/**
 * Build the SDK server URL for an agent, including the agent's workdir as
 * the `directory` query param so the SDK resolves the correct project context.
 */
function sdkUrl(agentId: string, path: string): string | null {
  const agent = getAgentStatus(agentId);
  if (!agent?.serverPort) return null;
  const sep = path.includes('?') ? '&' : '?';
  return `http://127.0.0.1:${agent.serverPort}${path}${sep}directory=${encodeURIComponent(agent.workdir)}`;
}

async function proxyToSDK(agentId: string, path: string, init?: RequestInit): Promise<Response> {
  const url = sdkUrl(agentId, path);
  if (!url)
    return new Response(JSON.stringify({ error: `Agent ${agentId} not found or not running` }), {
      status: 404,
    });
  const resp = await fetch(url, init);
  const body = await resp.text();
  return new Response(body, {
    status: resp.status,
    headers: { 'Content-Type': resp.headers.get('Content-Type') ?? 'application/json' },
  });
}

// POST /agents/:agentId/pty — get-or-create a TUI PTY session for the agent.
// Reuses an existing running session if one exists, otherwise creates a new
// one in the agent's workdir context (which launches the kilo TUI, not a raw
// shell). The `directory` query param tells the SDK server which project to use.
app.post('/agents/:agentId/pty', async c => {
  const { agentId } = c.req.param();
  const listUrl = sdkUrl(agentId, '/pty');
  if (!listUrl) {
    return c.json({ error: `Agent ${agentId} not found or not running` }, 404);
  }

  // Check for an existing running PTY session we can reuse
  try {
    const listResp = await fetch(listUrl);
    if (listResp.ok) {
      const raw: unknown = await listResp.json();
      const sessions: unknown[] = Array.isArray(raw) ? raw : [];
      const running = sessions.find(
        (s): s is { id: string; status: string } =>
          typeof s === 'object' &&
          s !== null &&
          'id' in s &&
          'status' in s &&
          s.status === 'running'
      );
      if (running) {
        console.log(
          `[control-server] Reusing existing PTY session ${running.id} for agent ${agentId}`
        );
        return c.json(running);
      }
    }
  } catch {
    // Fall through to create
  }

  // No existing session — create one. Use `kilo attach` to connect the TUI
  // to the EXISTING SDK server (started by process-manager) rather than
  // launching a separate server. This ensures the TUI shares the same
  // sessions, system prompts, model config, and provider credentials.
  const agent = getAgentStatus(agentId);
  const createUrl = sdkUrl(agentId, '/pty');
  if (!createUrl || !agent?.serverPort || !agent?.sessionId) {
    return c.json({ error: `Agent ${agentId} not found or not running` }, 404);
  }

  // Forward config env vars for the kilo attach process
  const ptyEnv: Record<string, string> = {};
  for (const key of [
    'KILO_CONFIG_CONTENT',
    'OPENCODE_CONFIG_CONTENT',
    'KILOCODE_TOKEN',
    'KILO_API_URL',
    'KILO_OPENROUTER_BASE',
  ]) {
    if (process.env[key]) ptyEnv[key] = process.env[key];
  }

  // `kilo attach <url>` connects to an existing kilo-serve instance.
  // --session resumes the agent's headless session (with system prompt + model).
  const serverUrl = `http://127.0.0.1:${agent.serverPort}`;
  const cliArgs: string[] = ['attach', serverUrl];
  cliArgs.push(`--session=${agent.sessionId}`);

  console.log(`[control-server] Creating PTY for agent ${agentId}: kilo ${cliArgs.join(' ')}`);

  const createResp = await fetch(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: 'kilo',
      args: cliArgs,
      cwd: agent.workdir,
      title: `kilo – ${agent.name}`,
      env: ptyEnv,
    }),
  });
  const data = await createResp.text();
  console.log(
    `[control-server] Created new PTY session for agent ${agentId}: ${data.slice(0, 200)}`
  );
  return new Response(data, {
    status: createResp.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

// GET /agents/:agentId/pty — list PTY sessions
app.get('/agents/:agentId/pty', c => {
  const { agentId } = c.req.param();
  return proxyToSDK(agentId, '/pty');
});

// GET /agents/:agentId/pty/:ptyId — get PTY session info
app.get('/agents/:agentId/pty/:ptyId', c => {
  const { agentId, ptyId } = c.req.param();
  return proxyToSDK(agentId, `/pty/${ptyId}`);
});

// PUT /agents/:agentId/pty/:ptyId — resize PTY
app.put('/agents/:agentId/pty/:ptyId', async c => {
  const { agentId, ptyId } = c.req.param();
  const body = await c.req.text();
  return proxyToSDK(agentId, `/pty/${ptyId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
});

// DELETE /agents/:agentId/pty/:ptyId — destroy PTY session
app.delete('/agents/:agentId/pty/:ptyId', c => {
  const { agentId, ptyId } = c.req.param();
  return proxyToSDK(agentId, `/pty/${ptyId}`, { method: 'DELETE' });
});

// Note: GET /agents/:agentId/pty/:ptyId/connect (WebSocket) is handled
// in the Bun.serve fetch handler below, not through Hono.

// Catch-all
app.notFound(c => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : 'Internal server error';
  console.error('Control server error:', err);
  return c.json({ error: message }, 500);
});

/**
 * Start the control server using Bun.serve + Hono, with WebSocket support.
 *
 * The /ws endpoint provides a multiplexed event stream for all agents.
 * SDK events from process-manager are forwarded to all connected WS clients.
 */
export function startControlServer(): void {
  const PORT = 8080;

  // Start heartbeat if env vars are configured.
  // Prefer container secret (no expiry) over session token (8h JWT).
  const apiUrl = process.env.GASTOWN_API_URL;
  const authToken = process.env.GASTOWN_CONTAINER_TOKEN ?? process.env.GASTOWN_SESSION_TOKEN;
  if (apiUrl && authToken) {
    startHeartbeat(apiUrl, authToken);
  }

  // Handle graceful shutdown (immediate, no drain — used by SIGINT for dev)
  const shutdown = async () => {
    console.log('Shutting down control server...');
    stopHeartbeat();
    await stopAll();
    process.exit(0);
  };

  process.on(
    'SIGTERM',
    () =>
      void (async () => {
        console.log('[control-server] SIGTERM received — starting graceful drain...');
        stopHeartbeat();
        await drainAll();
        await stopAll();
        process.exit(0);
      })()
  );

  process.on('SIGINT', () => void shutdown());

  // Track connected WebSocket clients with optional agent filter
  type WSClient = import('bun').ServerWebSocket<WSData>; // eslint-disable-line @typescript-eslint/consistent-type-imports
  const wsClients = new Set<WSClient>();

  // Agent stream URL patterns (the container receives the full path from the worker)
  const AGENT_STREAM_RE = /\/agents\/([^/]+)\/stream$/;
  // PTY WebSocket URL pattern: /agents/:agentId/pty/:ptyId/connect
  const PTY_CONNECT_RE = /\/agents\/([^/]+)\/pty\/([^/]+)\/connect$/;

  // Register an event sink that forwards agent events to WS clients
  registerEventSink((agentId, event, data) => {
    const frame = JSON.stringify({
      agentId,
      event,
      data,
      timestamp: new Date().toISOString(),
    });
    for (const ws of wsClients) {
      try {
        // If the client subscribed to a specific agent, only send that agent's events
        const filter = ws.data.agentId;
        if (filter && filter !== agentId) continue;
        ws.send(frame);
      } catch {
        wsClients.delete(ws);
      }
    }
  });

  // Track PTY WebSocket pairs for bidirectional proxying.
  // Maps the external (browser-side) Bun ServerWebSocket to the internal (SDK-side) WS.
  // Use `object` key type since Bun.ServerWebSocket is not assignable to WebSocket.
  const ptyUpstreamMap = new WeakMap<object, WebSocket>();

  type WSData = {
    agentId: string | null;
    /** If set, this is a PTY proxy connection — not an event stream. */
    ptyId?: string;
  };

  Bun.serve<WSData>({
    port: PORT,
    fetch(req, server) {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // WebSocket upgrade: match /ws, /agents/:id/stream, or /agents/:id/pty/:ptyId/connect
      const isWsUpgrade = req.headers.get('upgrade')?.toLowerCase() === 'websocket';
      if (isWsUpgrade) {
        // PTY connect — bidirectional raw byte proxy
        const ptyMatch = pathname.match(PTY_CONNECT_RE);
        if (ptyMatch) {
          const agentId = ptyMatch[1];
          const ptyId = ptyMatch[2];
          const upgraded = server.upgrade(req, { data: { agentId, ptyId } });
          if (upgraded) return undefined;
          return new Response('WebSocket upgrade failed', { status: 400 });
        }

        let agentId: string | null = null;

        if (pathname === '/ws') {
          agentId = url.searchParams.get('agentId');
        } else {
          const match = pathname.match(AGENT_STREAM_RE);
          if (match) agentId = match[1];
        }

        // Accept upgrade if the path matches any WS pattern
        if (pathname === '/ws' || AGENT_STREAM_RE.test(pathname)) {
          const upgraded = server.upgrade(req, { data: { agentId } });
          if (upgraded) return undefined;
          return new Response('WebSocket upgrade failed', { status: 400 });
        }
      }

      // All other requests go through Hono
      return app.fetch(req);
    },
    websocket: {
      open(ws) {
        // PTY proxy connection — connect to the SDK server's PTY WS
        if (ws.data.ptyId) {
          const agent = getAgentStatus(ws.data.agentId ?? '');
          if (!agent || !agent.serverPort) {
            console.warn(`[control-server] PTY WS open: agent ${ws.data.agentId} not found`);
            ws.close(1011, 'Agent not found');
            return;
          }

          const dirParam = `?directory=${encodeURIComponent(agent.workdir)}`;
          const sdkWsUrl = `ws://127.0.0.1:${agent.serverPort}/pty/${ws.data.ptyId}/connect${dirParam}`;
          console.log(`[control-server] PTY WS: proxying to ${sdkWsUrl}`);

          const upstream = new WebSocket(sdkWsUrl);
          ptyUpstreamMap.set(ws, upstream);

          upstream.binaryType = 'arraybuffer';

          upstream.onopen = () => {
            console.log(`[control-server] PTY WS: upstream connected for pty=${ws.data.ptyId}`);
          };
          upstream.onmessage = (e: MessageEvent) => {
            try {
              // Forward raw bytes from SDK → browser
              ws.send(e.data instanceof ArrayBuffer ? e.data : String(e.data));
            } catch {
              // Client disconnected
            }
          };
          upstream.onclose = () => {
            try {
              ws.close(1000, 'PTY session ended');
            } catch {
              /* already closed */
            }
          };
          upstream.onerror = () => {
            try {
              ws.close(1011, 'PTY upstream error');
            } catch {
              /* already closed */
            }
          };
          return;
        }

        // Event stream connection
        wsClients.add(ws);
        const agentFilter = ws.data.agentId ?? 'all';
        console.log(
          `[control-server] WebSocket connected: agent=${agentFilter} (${wsClients.size} total)`
        );

        // Send in-memory backfill for this session's events.
        if (ws.data.agentId) {
          const events = getAgentEvents(ws.data.agentId, 0);
          for (const evt of events) {
            try {
              ws.send(
                JSON.stringify({
                  agentId: ws.data.agentId,
                  event: evt.event,
                  data: evt.data,
                  timestamp: evt.timestamp,
                })
              );
            } catch {
              break;
            }
          }
        }
      },
      message(ws, message) {
        // PTY proxy — forward browser input to SDK
        if (ws.data.ptyId) {
          const upstream = ptyUpstreamMap.get(ws);
          if (upstream && upstream.readyState === WebSocket.OPEN) {
            upstream.send(message);
          }
          return;
        }

        // Event stream — handle subscribe messages
        try {
          const msg = JSON.parse(String(message)) as unknown;
          const rec =
            typeof msg === 'object' && msg !== null ? (msg as Record<string, unknown>) : null;
          if (rec && rec.type === 'subscribe' && typeof rec.agentId === 'string') {
            ws.data.agentId = rec.agentId;
            console.log(`[control-server] WebSocket subscribed to agent=${rec.agentId}`);
          }
        } catch {
          // Ignore
        }
      },
      close(ws) {
        // PTY proxy — close upstream
        if (ws.data.ptyId) {
          const upstream = ptyUpstreamMap.get(ws);
          if (upstream) {
            try {
              upstream.close();
            } catch {
              /* already closed */
            }
            ptyUpstreamMap.delete(ws);
          }
          console.log(`[control-server] PTY WS disconnected: pty=${ws.data.ptyId}`);
          return;
        }

        wsClients.delete(ws);
        console.log(`[control-server] WebSocket disconnected (${wsClients.size} total)`);
      },
    },
  });

  console.log(`Town container control server listening on port ${PORT}`);
}
