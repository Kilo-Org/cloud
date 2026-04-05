import * as Sentry from '@sentry/cloudflare';
import { withSentry } from '@sentry/cloudflare';
import { TRPCError } from '@trpc/server';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import { getTownContainerStub } from './dos/TownContainer.do';
import { getTownDOStub } from './dos/Town.do';
import { resError } from './util/res.util';
import {
  authMiddleware,
  agentOnlyMiddleware,
  townIdMiddleware,
  type AuthVariables,
} from './middleware/auth.middleware';
import { kiloAuthMiddleware } from './middleware/kilo-auth.middleware';

import { trpcServer } from '@hono/trpc-server';
import { wrappedGastownRouter } from './trpc/router';
import {
  handleCreateBead,
  handleListBeads,
  handleGetBead,
  handleUpdateBeadStatus,
  handleCloseBead,
  handleSlingBead,
  handleDeleteBead,
} from './handlers/rig-beads.handler';
import {
  handleRegisterAgent,
  handleListAgents,
  handleGetAgent,
  handleHookBead,
  handleUnhookBead,
  handlePrime,
  handleAgentDone,
  handleRequestChanges,
  handleAgentCompleted,
  handleAgentWaiting,
  handleWriteCheckpoint,
  handleWriteEvictionContext,
  handleCheckMail,
  handleHeartbeat,
  handleGetOrCreateAgent,
  handleDeleteAgent,
  handleUpdateAgentStatusMessage,
  handleGetPendingNudges,
  handleNudgeDelivered,
  handleNudge,
} from './handlers/rig-agents.handler';
import { handleSendMail } from './handlers/rig-mail.handler';
import { handleAppendAgentEvent, handleGetAgentEvents } from './handlers/rig-agent-events.handler';
import {
  handleSubmitToReviewQueue,
  handleCompleteReview,
} from './handlers/rig-review-queue.handler';
import { handleCreateEscalation } from './handlers/rig-escalations.handler';
import { handleResolveTriage } from './handlers/rig-triage.handler';
import { handleListBeadEvents } from './handlers/rig-bead-events.handler';
import { handleListTownEvents } from './handlers/town-events.handler';
import {
  handleContainerStartAgent,
  handleContainerStopAgent,
  handleContainerSendMessage,
  handleContainerAgentStatus,
  handleContainerStreamTicket,
  handleContainerHealth,
  handleContainerProxy,
} from './handlers/town-container.handler';
import {
  handleCreateTown,
  handleListTowns,
  handleGetTown,
  handleCreateRig,
  handleGetRig,
  handleListRigs,
  handleDeleteTown,
  handleDeleteRig,
} from './handlers/towns.handler';
import {
  handleCreateOrgTown,
  handleListOrgTowns,
  handleGetOrgTown,
  handleCreateOrgRig,
  handleListOrgRigs,
  handleGetOrgRig,
  handleDeleteOrgTown,
  handleDeleteOrgRig,
} from './handlers/org-towns.handler';
import {
  handleConfigureMayor,
  handleSendMayorMessage,
  handleGetMayorStatus,
  handleEnsureMayor,
  handleMayorCompleted,
  handleDestroyMayor,
  handleBroadcastUiAction,
  handleSetDashboardContext,
} from './handlers/mayor.handler';
import {
  handleMayorSling,
  handleMayorSlingBatch,
  handleMayorListRigs,
  handleMayorListBeads,
  handleMayorListAgents,
  handleMayorSendMail,
  handleMayorListConvoys,
  handleMayorConvoyStatus,
  handleMayorBeadUpdate,
  handleMayorBeadReassign,
  handleMayorAgentReset,
  handleMayorConvoyClose,
  handleMayorConvoyUpdate,
  handleMayorBeadDelete,
  handleMayorEscalationAcknowledge,
  handleMayorConvoyStart,
  handleMayorUiAction,
  handleMayorGetPendingNudges,
} from './handlers/mayor-tools.handler';
import { mayorAuthMiddleware } from './middleware/mayor-auth.middleware';
import { townAuthMiddleware } from './middleware/town-auth.middleware';
import { orgAuthMiddleware } from './middleware/org-auth.middleware';
import { adminAuditMiddleware } from './middleware/admin-audit.middleware';
import { timingMiddleware, instrumented } from './middleware/analytics.middleware';
import { logger } from './util/log.util';
import { useWorkersLogger } from 'workers-tagged-logger';
import type { MiddlewareHandler } from 'hono';
import { handleGetTownConfig, handleUpdateTownConfig } from './handlers/town-config.handler';
import {
  handleGetMoleculeCurrentStep,
  handleAdvanceMoleculeStep,
  handleCreateMolecule,
} from './handlers/rig-molecules.handler';
import { handleCreateConvoy, handleOnBeadClosed } from './handlers/town-convoys.handler';
import {
  handleListEscalations,
  handleAcknowledgeEscalation,
} from './handlers/town-escalations.handler';
import {
  handleContainerEviction,
  handleContainerReady,
  handleDrainStatus,
} from './handlers/town-eviction.handler';

export { GastownUserDO } from './dos/GastownUser.do';
export { GastownOrgDO } from './dos/GastownOrg.do';
export { AgentIdentityDO } from './dos/AgentIdentity.do';
export { TownDO } from './dos/Town.do';
export { TownContainerDO } from './dos/TownContainer.do';
export { AgentDO } from './dos/Agent.do';

export type GastownEnv = {
  Bindings: Env;
  Variables: AuthVariables;
};

const app = new Hono<GastownEnv>();

// ── Timing ──────────────────────────────────────────────────────────────
// Capture high-resolution start timestamp before any other middleware.
app.use('*', timingMiddleware);

// ── Structured logging context ──────────────────────────────────────────
// Establishes AsyncLocalStorage context so all downstream logs are tagged.
// Cast needed: workers-tagged-logger@1.0.0 was built against an older Hono.
app.use('*', useWorkersLogger('gastown-worker') as unknown as MiddlewareHandler);

// ── Request logging ─────────────────────────────────────────────────────
// Extract IDs from the URL path directly — c.req.param() only works
// after Hono has matched a route, which hasn't happened yet in a
// wildcard middleware.
// Matches /orgs/:orgId, /towns/:townId, /rigs/:rigId, /agents/:agentId
// in any combination that appears in our route patterns.
const RE_ORG = /\/orgs\/(?<orgId>[^/]+)/;
const RE_TOWN = /\/towns\/(?<townId>[^/]+)/;
const RE_RIG = /\/rigs\/(?<rigId>[^/]+)/;
const RE_AGENT = /\/agents\/(?<agentId>[^/]+)/;

app.use('*', async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;
  // Tag with route params immediately so all downstream logs (auth,
  // handlers, DO calls) inherit them. Auth-derived tags (userId, orgId)
  // are set by kiloAuthMiddleware and orgAuthMiddleware when they run.
  logger.setTags({
    orgId: RE_ORG.exec(path)?.groups?.orgId,
    townId: RE_TOWN.exec(path)?.groups?.townId,
    rigId: RE_RIG.exec(path)?.groups?.rigId,
    agentId: RE_AGENT.exec(path)?.groups?.agentId,
  });
  logger.info(`--> ${method} ${path}`);
  await next();
  const elapsed = Math.round(performance.now() - (c.get('requestStartTime') ?? 0));
  logger.info(`<-- ${method} ${path} ${c.res.status}`, { durationMs: elapsed });
});

// ── CORS ────────────────────────────────────────────────────────────────
// Allow browser requests from the main Kilo app. In development, allow
// localhost origins for the Next.js dev server.

const corsMiddleware = cors({
  origin: (origin, c: Context<GastownEnv>) => {
    if (c.env.ENVIRONMENT === 'development') {
      // Allow any localhost origin in dev
      if (origin.startsWith('http://localhost:')) return origin;
    }
    // Production origins
    const allowed = ['https://app.kilo.ai', 'https://kilo.ai'];
    return allowed.includes(origin) ? origin : '';
  },
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 3600,
  credentials: true,
});

app.use('/api/*', corsMiddleware);
app.use('/trpc/*', corsMiddleware);

// ── Health ──────────────────────────────────────────────────────────────

app.get('/', c => c.json({ service: 'gastown', status: 'ok' }));
app.get('/health', c => c.json({ status: 'ok' }));

// ── DEBUG: unauthenticated town introspection — REMOVE after debugging ──
app.get('/debug/towns/:townId/status', async c => {
  const townId = c.req.param('townId');
  const town = getTownDOStub(c.env, townId);
  const alarmStatus = await town.getAlarmStatus();
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const agentMeta = await town.debugAgentMetadata();
  // eslint-disable-next-line @typescript-eslint/await-thenable
  const beadSummary = await town.debugBeadSummary();
  return c.json({ alarmStatus, agentMeta, beadSummary });
});

app.post('/debug/towns/:townId/reconcile-dry-run', async c => {
  const townId = c.req.param('townId');
  const town = getTownDOStub(c.env, townId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const result = await town.debugDryRun();
  return c.json(result);
});

app.post('/debug/towns/:townId/replay-events', async c => {
  const townId = c.req.param('townId');
  const body: { from?: string; to?: string } = await c.req.json();
  if (!body.from || !body.to) {
    return c.json({ error: 'Missing required fields: from, to (ISO timestamps)' }, 400);
  }
  const fromDate = new Date(body.from);
  const toDate = new Date(body.to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return c.json({ error: 'Invalid date format. Use ISO 8601 timestamps.' }, 400);
  }
  if (fromDate > toDate) {
    return c.json({ error: '"from" must be before or equal to "to"' }, 400);
  }
  const town = getTownDOStub(c.env, townId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const result = await town.debugReplayEvents(body.from, body.to);
  return c.json(result);
});

app.get('/debug/towns/:townId/drain-status', async c => {
  const townId = c.req.param('townId');
  const town = getTownDOStub(c.env, townId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const draining = await town.isDraining();
  // eslint-disable-next-line @typescript-eslint/await-thenable
  const drainNonce = await town.getDrainNonce();
  return c.json({ draining, drainNonce });
});

app.get('/debug/towns/:townId/nudges', async c => {
  const townId = c.req.param('townId');
  const town = getTownDOStub(c.env, townId);
  // eslint-disable-next-line @typescript-eslint/await-thenable -- DO RPC returns promise at runtime
  const nudges = await town.debugPendingNudges();
  return c.json({ nudges });
});

app.post('/debug/towns/:townId/send-message', async c => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'dev only' }, 403);
  const townId = c.req.param('townId');
  const body: { message: string; model?: string } = await c.req.json();
  const town = getTownDOStub(c.env, townId);
  // eslint-disable-next-line @typescript-eslint/await-thenable
  const result = await town.sendMayorMessage(
    body.message,
    body.model ?? 'anthropic/claude-sonnet-4.6'
  );
  return c.json(result);
});

app.get('/debug/towns/:townId/beads/:beadId', async c => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'dev only' }, 403);
  const townId = c.req.param('townId');
  const beadId = c.req.param('beadId');
  const town = getTownDOStub(c.env, townId);
  // eslint-disable-next-line @typescript-eslint/await-thenable
  const result = await town.debugGetBead(beadId);
  return c.json(result);
});

app.post('/debug/towns/:townId/graceful-stop', async c => {
  if (c.env.ENVIRONMENT !== 'development') return c.json({ error: 'dev only' }, 403);
  const townId = c.req.param('townId');
  const containerStub = getTownContainerStub(c.env, townId);
  await containerStub.stop();
  return c.json({ stopped: true });
});

// ── Town ID + Auth ──────────────────────────────────────────────────────
// All rig routes live under /api/towns/:townId/rigs/:rigId so the townId
// is always available from the URL path.
// townIdMiddleware always runs (even in dev) so c.get('townId') is
// guaranteed for handlers. Auth middleware is skipped in dev.

app.use('/api/towns/:townId/rigs/:rigId/*', townIdMiddleware);
app.use('/api/towns/:townId/rigs/:rigId/*', async (c: Context<GastownEnv, string>, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : authMiddleware(c, next)
);

// ── Beads ───────────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/beads', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/beads', () =>
    handleCreateBead(c, c.req.param())
  )
);
app.get('/api/towns/:townId/rigs/:rigId/beads', c =>
  instrumented(c, 'GET /api/towns/:townId/rigs/:rigId/beads', () =>
    handleListBeads(c, c.req.param())
  )
);
app.get('/api/towns/:townId/rigs/:rigId/beads/:beadId', c =>
  instrumented(c, 'GET /api/towns/:townId/rigs/:rigId/beads/:beadId', () =>
    handleGetBead(c, c.req.param())
  )
);
app.patch('/api/towns/:townId/rigs/:rigId/beads/:beadId/status', c =>
  instrumented(c, 'PATCH /api/towns/:townId/rigs/:rigId/beads/:beadId/status', () =>
    handleUpdateBeadStatus(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/beads/:beadId/close', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/beads/:beadId/close', () =>
    handleCloseBead(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/sling', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/sling', () =>
    handleSlingBead(c, c.req.param())
  )
);
app.delete('/api/towns/:townId/rigs/:rigId/beads/:beadId', c =>
  instrumented(c, 'DELETE /api/towns/:townId/rigs/:rigId/beads/:beadId', () =>
    handleDeleteBead(c, c.req.param())
  )
);

// ── Agents ──────────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/agents', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents', () =>
    handleRegisterAgent(c, c.req.param())
  )
);
app.get('/api/towns/:townId/rigs/:rigId/agents', c =>
  instrumented(c, 'GET /api/towns/:townId/rigs/:rigId/agents', () =>
    handleListAgents(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/agents/get-or-create', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/get-or-create', () =>
    handleGetOrCreateAgent(c, c.req.param())
  )
);
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId', c =>
  instrumented(c, 'GET /api/towns/:townId/rigs/:rigId/agents/:agentId', () =>
    handleGetAgent(c, c.req.param())
  )
);
app.delete('/api/towns/:townId/rigs/:rigId/agents/:agentId', c =>
  instrumented(c, 'DELETE /api/towns/:townId/rigs/:rigId/agents/:agentId', () =>
    handleDeleteAgent(c, c.req.param())
  )
);

// Dashboard-accessible agent events (before agentOnlyMiddleware so the
// frontend can query events without an agent JWT)
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId/events', c =>
  instrumented(c, 'GET /api/towns/:townId/rigs/:rigId/agents/:agentId/events', () =>
    handleGetAgentEvents(c, c.req.param())
  )
);

// Agent-scoped routes — agentOnlyMiddleware enforces JWT agentId match
app.use(
  '/api/towns/:townId/rigs/:rigId/agents/:agentId/*',
  async (c: Context<GastownEnv, string>, next) =>
    c.env.ENVIRONMENT === 'development' ? next() : agentOnlyMiddleware(c, next)
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/hook', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/:agentId/hook', () =>
    handleHookBead(c, c.req.param())
  )
);
app.delete('/api/towns/:townId/rigs/:rigId/agents/:agentId/hook', c =>
  instrumented(c, 'DELETE /api/towns/:townId/rigs/:rigId/agents/:agentId/hook', () =>
    handleUnhookBead(c, c.req.param())
  )
);
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId/prime', c =>
  instrumented(c, 'GET /api/towns/:townId/rigs/:rigId/agents/:agentId/prime', () =>
    handlePrime(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/done', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/:agentId/done', () =>
    handleAgentDone(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/request-changes', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/:agentId/request-changes', () =>
    handleRequestChanges(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/completed', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/:agentId/completed', () =>
    handleAgentCompleted(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/waiting', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/:agentId/waiting', () =>
    handleAgentWaiting(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/checkpoint', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/:agentId/checkpoint', () =>
    handleWriteCheckpoint(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/eviction-context', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/:agentId/eviction-context', () =>
    handleWriteEvictionContext(c, c.req.param())
  )
);
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId/mail', c =>
  instrumented(c, 'GET /api/towns/:townId/rigs/:rigId/agents/:agentId/mail', () =>
    handleCheckMail(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/heartbeat', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/:agentId/heartbeat', () =>
    handleHeartbeat(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/status', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/:agentId/status', () =>
    handleUpdateAgentStatusMessage(c, c.req.param())
  )
);
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId/pending-nudges', c =>
  handleGetPendingNudges(c, c.req.param())
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/nudge-delivered', c =>
  handleNudgeDelivered(c, c.req.param())
);

// Agent-to-agent nudge: any authenticated agent can nudge another agent in the rig
app.post('/api/towns/:townId/rigs/:rigId/nudge', c => handleNudge(c, c.req.param()));

// ── Agent Events ─────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/agent-events', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agent-events', () =>
    handleAppendAgentEvent(c, c.req.param())
  )
);

// ── Mail ────────────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/mail', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/mail', () =>
    handleSendMail(c, c.req.param())
  )
);

// ── Review Queue ────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/review-queue', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/review-queue', () =>
    handleSubmitToReviewQueue(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/review-queue/:entryId/complete', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/review-queue/:entryId/complete', () =>
    handleCompleteReview(c, c.req.param())
  )
);

// ── Bead Events ─────────────────────────────────────────────────────────

app.get('/api/towns/:townId/rigs/:rigId/events', c =>
  instrumented(c, 'GET /api/towns/:townId/rigs/:rigId/events', () =>
    handleListBeadEvents(c, c.req.param())
  )
);

// ── Molecules ────────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/molecules', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/molecules', () =>
    handleCreateMolecule(c, c.req.param())
  )
);
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId/molecule/current', c =>
  instrumented(c, 'GET /api/towns/:townId/rigs/:rigId/agents/:agentId/molecule/current', () =>
    handleGetMoleculeCurrentStep(c, c.req.param())
  )
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/molecule/advance', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/agents/:agentId/molecule/advance', () =>
    handleAdvanceMoleculeStep(c, c.req.param())
  )
);

// ── Escalations ─────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/escalations', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/escalations', () =>
    handleCreateEscalation(c, c.req.param())
  )
);

// ── Triage ──────────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/triage/resolve', c =>
  instrumented(c, 'POST /api/towns/:townId/rigs/:rigId/triage/resolve', () =>
    handleResolveTriage(c, c.req.param())
  )
);

// ── Container Eviction ──────────────────────────────────────────────────
// Called by the container on SIGTERM. Uses container JWT auth (not kilo
// user auth), so it must be registered before the kiloAuthMiddleware
// wildcard below.

app.post('/api/towns/:townId/container-eviction', c =>
  instrumented(c, 'POST /api/towns/:townId/container-eviction', () =>
    handleContainerEviction(c, c.req.param())
  )
);

app.post('/api/towns/:townId/container-ready', c =>
  instrumented(c, 'POST /api/towns/:townId/container-ready', () =>
    handleContainerReady(c, c.req.param())
  )
);

app.get('/api/towns/:townId/drain-status', c =>
  instrumented(c, 'GET /api/towns/:townId/drain-status', () => handleDrainStatus(c, c.req.param()))
);

// ── Kilo User Auth ──────────────────────────────────────────────────────
// Validate Kilo user JWT (signed with NEXTAUTH_SECRET) for dashboard/user
// routes. Container→worker routes use the agent JWT middleware instead
// (authMiddleware above).

app.use('/api/users/*', async (c: Context<GastownEnv, string>, next) =>
  kiloAuthMiddleware(c, next)
);
// Town routes: kilo auth + admin audit + town ownership check (supports both personal and org-owned towns).
app.use('/api/towns/:townId/*', async (c: Context<GastownEnv, string>, next) =>
  kiloAuthMiddleware(c, async () => {
    await adminAuditMiddleware(c, async () => {
      await townAuthMiddleware(c, next);
    });
  })
);

// ── Org Auth ────────────────────────────────────────────────────────────
// Kilo user auth + org membership check for all org routes.

app.use('/api/orgs/:orgId/*', async (c: Context<GastownEnv, string>, next) =>
  kiloAuthMiddleware(c, next)
);
app.use('/api/orgs/:orgId/*', async (c: Context<GastownEnv, string>, next) =>
  orgAuthMiddleware(c, next)
);

// ── Org Towns & Rigs ─────────────────────────────────────────────────────
// GastownOrgDO instances are keyed by orgId. One DO instance per org stores
// all towns and rigs the org owns.

app.post('/api/orgs/:orgId/towns', c =>
  instrumented(c, 'POST /api/orgs/:orgId/towns', () => handleCreateOrgTown(c, c.req.param()))
);
app.get('/api/orgs/:orgId/towns', c =>
  instrumented(c, 'GET /api/orgs/:orgId/towns', () => handleListOrgTowns(c, c.req.param()))
);
app.get('/api/orgs/:orgId/towns/:townId', c =>
  instrumented(c, 'GET /api/orgs/:orgId/towns/:townId', () => handleGetOrgTown(c, c.req.param()))
);
app.post('/api/orgs/:orgId/rigs', c =>
  instrumented(c, 'POST /api/orgs/:orgId/rigs', () => handleCreateOrgRig(c, c.req.param()))
);
app.get('/api/orgs/:orgId/towns/:townId/rigs', c =>
  instrumented(c, 'GET /api/orgs/:orgId/towns/:townId/rigs', () =>
    handleListOrgRigs(c, c.req.param())
  )
);
app.get('/api/orgs/:orgId/rigs/:rigId', c =>
  instrumented(c, 'GET /api/orgs/:orgId/rigs/:rigId', () => handleGetOrgRig(c, c.req.param()))
);
app.delete('/api/orgs/:orgId/towns/:townId', c =>
  instrumented(c, 'DELETE /api/orgs/:orgId/towns/:townId', () =>
    handleDeleteOrgTown(c, c.req.param())
  )
);
app.delete('/api/orgs/:orgId/rigs/:rigId', c =>
  instrumented(c, 'DELETE /api/orgs/:orgId/rigs/:rigId', () => handleDeleteOrgRig(c, c.req.param()))
);

// ── Towns & Rigs ────────────────────────────────────────────────────────
// Town DO instances are keyed by owner_user_id. The userId path param routes
// to the correct DO instance so each user's towns are isolated.

app.post('/api/users/:userId/towns', c =>
  instrumented(c, 'POST /api/users/:userId/towns', () => handleCreateTown(c, c.req.param()))
);
app.get('/api/users/:userId/towns', c =>
  instrumented(c, 'GET /api/users/:userId/towns', () => handleListTowns(c, c.req.param()))
);
app.get('/api/users/:userId/towns/:townId', c =>
  instrumented(c, 'GET /api/users/:userId/towns/:townId', () => handleGetTown(c, c.req.param()))
);
app.post('/api/users/:userId/rigs', c =>
  instrumented(c, 'POST /api/users/:userId/rigs', () => handleCreateRig(c, c.req.param()))
);
app.get('/api/users/:userId/rigs/:rigId', c =>
  instrumented(c, 'GET /api/users/:userId/rigs/:rigId', () => handleGetRig(c, c.req.param()))
);
app.get('/api/users/:userId/towns/:townId/rigs', c =>
  instrumented(c, 'GET /api/users/:userId/towns/:townId/rigs', () =>
    handleListRigs(c, c.req.param())
  )
);
app.delete('/api/users/:userId/towns/:townId', c =>
  instrumented(c, 'DELETE /api/users/:userId/towns/:townId', () =>
    handleDeleteTown(c, c.req.param())
  )
);
app.delete('/api/users/:userId/rigs/:rigId', c =>
  instrumented(c, 'DELETE /api/users/:userId/rigs/:rigId', () => handleDeleteRig(c, c.req.param()))
);

// ── Town Convoys ─────────────────────────────────────────────────────────

app.post('/api/towns/:townId/convoys', c =>
  instrumented(c, 'POST /api/towns/:townId/convoys', () => handleCreateConvoy(c, c.req.param()))
);
app.post('/api/towns/:townId/convoys/bead-closed', c =>
  instrumented(c, 'POST /api/towns/:townId/convoys/bead-closed', () =>
    handleOnBeadClosed(c, c.req.param())
  )
);

// ── Town Escalations ─────────────────────────────────────────────────────

app.get('/api/towns/:townId/escalations', c =>
  instrumented(c, 'GET /api/towns/:townId/escalations', () =>
    handleListEscalations(c, c.req.param())
  )
);
app.post('/api/towns/:townId/escalations/:escalationId/acknowledge', c =>
  instrumented(c, 'POST /api/towns/:townId/escalations/:escalationId/acknowledge', () =>
    handleAcknowledgeEscalation(c, c.req.param())
  )
);

// ── Town Configuration ──────────────────────────────────────────────────

app.get('/api/towns/:townId/config', c =>
  instrumented(c, 'GET /api/towns/:townId/config', () => handleGetTownConfig(c, c.req.param()))
);
app.patch('/api/towns/:townId/config', c =>
  instrumented(c, 'PATCH /api/towns/:townId/config', () => handleUpdateTownConfig(c, c.req.param()))
);

// ── Cloudflare Debug ────────────────────────────────────────────────
// Returns DO IDs and namespace IDs for constructing Cloudflare dashboard URLs.
// containerDoId is only returned when the container is actually running,
// so the UI correctly shows a disabled state when the container is stopped.

app.get('/api/towns/:townId/cloudflare-debug', async c => {
  const townId = c.req.param('townId');
  const townDoId = c.env.TOWN.idFromName(townId).toString();

  // Check actual container runtime state before returning the DO ID.
  // idFromName() is deterministic and always returns an ID even when
  // no container instance is running — we need to gate on getState().
  const containerStub = getTownContainerStub(c.env, townId);
  const containerState = await containerStub.getState();
  const containerRunning =
    containerState.status === 'running' || containerState.status === 'healthy';
  const containerDoId = containerRunning
    ? c.env.TOWN_CONTAINER.idFromName(townId).toString()
    : null;

  return c.json({
    success: true,
    data: { townDoId, containerDoId },
  });
});

// ── Town Events ─────────────────────────────────────────────────────────

app.use('/api/users/:userId/towns/:townId/events', async (c: Context<GastownEnv, string>, next) =>
  townAuthMiddleware(c, next)
);
app.get('/api/users/:userId/towns/:townId/events', c =>
  instrumented(c, 'GET /api/users/:userId/towns/:townId/events', () =>
    handleListTownEvents(c, c.req.param())
  )
);

// ── Town Container ──────────────────────────────────────────────────────
// These routes proxy commands to the container's control server via DO.fetch().
// Protected by Cloudflare Access at the perimeter; no additional auth required.

app.post('/api/towns/:townId/container/agents/start', c =>
  instrumented(c, 'POST /api/towns/:townId/container/agents/start', () =>
    handleContainerStartAgent(c, c.req.param())
  )
);
app.post('/api/towns/:townId/container/agents/:agentId/stop', c =>
  instrumented(c, 'POST /api/towns/:townId/container/agents/:agentId/stop', () =>
    handleContainerStopAgent(c, c.req.param())
  )
);
app.post('/api/towns/:townId/container/agents/:agentId/message', c =>
  instrumented(c, 'POST /api/towns/:townId/container/agents/:agentId/message', () =>
    handleContainerSendMessage(c, c.req.param())
  )
);
app.get('/api/towns/:townId/container/agents/:agentId/status', c =>
  instrumented(c, 'GET /api/towns/:townId/container/agents/:agentId/status', () =>
    handleContainerAgentStatus(c, c.req.param())
  )
);
app.post('/api/towns/:townId/container/agents/:agentId/stream-ticket', c =>
  instrumented(c, 'POST /api/towns/:townId/container/agents/:agentId/stream-ticket', () =>
    handleContainerStreamTicket(c, c.req.param())
  )
);
// Note: GET /api/towns/:townId/container/agents/:agentId/stream (WebSocket)
// is handled outside Hono in the default export's fetch handler, which
// routes the upgrade directly to TownContainerDO.fetch().

app.get('/api/towns/:townId/container/health', c =>
  instrumented(c, 'GET /api/towns/:townId/container/health', () =>
    handleContainerHealth(c, c.req.param())
  )
);

// PTY routes — proxy to container's SDK PTY endpoints
app.post('/api/towns/:townId/container/agents/:agentId/pty', c =>
  instrumented(c, 'POST /api/towns/:townId/container/agents/:agentId/pty', () =>
    handleContainerProxy(c, c.req.param())
  )
);
app.get('/api/towns/:townId/container/agents/:agentId/pty', c =>
  instrumented(c, 'GET /api/towns/:townId/container/agents/:agentId/pty', () =>
    handleContainerProxy(c, c.req.param())
  )
);
app.get('/api/towns/:townId/container/agents/:agentId/pty/:ptyId', c =>
  instrumented(c, 'GET /api/towns/:townId/container/agents/:agentId/pty/:ptyId', () =>
    handleContainerProxy(c, c.req.param())
  )
);
app.put('/api/towns/:townId/container/agents/:agentId/pty/:ptyId', c =>
  instrumented(c, 'PUT /api/towns/:townId/container/agents/:agentId/pty/:ptyId', () =>
    handleContainerProxy(c, c.req.param())
  )
);
app.delete('/api/towns/:townId/container/agents/:agentId/pty/:ptyId', c =>
  instrumented(c, 'DELETE /api/towns/:townId/container/agents/:agentId/pty/:ptyId', () =>
    handleContainerProxy(c, c.req.param())
  )
);
// Note: GET /agents/:agentId/pty/:ptyId/connect (WebSocket) is handled
// in the default export's fetch handler, bypassing Hono.

// ── Mayor ────────────────────────────────────────────────────────────────
// MayorDO endpoints — town-level conversational agent with persistent session.

app.post('/api/towns/:townId/mayor/configure', c =>
  instrumented(c, 'POST /api/towns/:townId/mayor/configure', () =>
    handleConfigureMayor(c, c.req.param())
  )
);
app.post('/api/towns/:townId/mayor/message', c =>
  instrumented(c, 'POST /api/towns/:townId/mayor/message', () =>
    handleSendMayorMessage(c, c.req.param())
  )
);
app.get('/api/towns/:townId/mayor/status', c =>
  instrumented(c, 'GET /api/towns/:townId/mayor/status', () =>
    handleGetMayorStatus(c, c.req.param())
  )
);
app.post('/api/towns/:townId/mayor/ensure', c =>
  instrumented(c, 'POST /api/towns/:townId/mayor/ensure', () => handleEnsureMayor(c, c.req.param()))
);
app.post('/api/towns/:townId/mayor/completed', c =>
  instrumented(c, 'POST /api/towns/:townId/mayor/completed', () =>
    handleMayorCompleted(c, c.req.param())
  )
);
app.post('/api/towns/:townId/mayor/destroy', c =>
  instrumented(c, 'POST /api/towns/:townId/mayor/destroy', () =>
    handleDestroyMayor(c, c.req.param())
  )
);
app.post('/api/towns/:townId/mayor/dashboard-context', c =>
  instrumented(c, 'POST /api/towns/:townId/mayor/dashboard-context', () =>
    handleSetDashboardContext(c, c.req.param())
  )
);
app.post('/api/towns/:townId/mayor/ui-action', c =>
  instrumented(c, 'POST /api/towns/:townId/mayor/ui-action', () =>
    handleBroadcastUiAction(c, c.req.param())
  )
);

// ── Mayor Tools ──────────────────────────────────────────────────────────
// Tool endpoints called by the mayor's kilo serve session via the Gastown plugin.
// Authenticated via mayor JWT (townId-scoped, no rigId restriction).

// Always run mayor auth — even in dev. The handler's resolveUserId()
// reads agentJWT.userId which is only set after the middleware parses
// the token. Skipping auth in dev leaves agentJWT null and causes 401s
// from the handler itself.
app.use('/api/mayor/:townId/tools/*', mayorAuthMiddleware);

// Mayor tool: broadcast a UI action (called from the mayor container)
app.post('/api/mayor/:townId/tools/ui-action', c =>
  instrumented(c, 'POST /api/mayor/:townId/tools/ui-action', () =>
    handleMayorUiAction(c, c.req.param())
  )
);
app.get('/api/mayor/:townId/tools/rigs/:rigId/agents/:agentId/pending-nudges', c =>
  handleMayorGetPendingNudges(c, c.req.param())
);

app.post('/api/mayor/:townId/tools/sling', c =>
  instrumented(c, 'POST /api/mayor/:townId/tools/sling', () => handleMayorSling(c, c.req.param()))
);
app.post('/api/mayor/:townId/tools/sling-batch', c =>
  instrumented(c, 'POST /api/mayor/:townId/tools/sling-batch', () =>
    handleMayorSlingBatch(c, c.req.param())
  )
);
app.get('/api/mayor/:townId/tools/rigs', c =>
  instrumented(c, 'GET /api/mayor/:townId/tools/rigs', () => handleMayorListRigs(c, c.req.param()))
);
app.get('/api/mayor/:townId/tools/rigs/:rigId/beads', c =>
  instrumented(c, 'GET /api/mayor/:townId/tools/rigs/:rigId/beads', () =>
    handleMayorListBeads(c, c.req.param())
  )
);
app.get('/api/mayor/:townId/tools/rigs/:rigId/agents', c =>
  instrumented(c, 'GET /api/mayor/:townId/tools/rigs/:rigId/agents', () =>
    handleMayorListAgents(c, c.req.param())
  )
);
app.post('/api/mayor/:townId/tools/mail', c =>
  instrumented(c, 'POST /api/mayor/:townId/tools/mail', () => handleMayorSendMail(c, c.req.param()))
);
app.get('/api/mayor/:townId/tools/convoys', c =>
  instrumented(c, 'GET /api/mayor/:townId/tools/convoys', () =>
    handleMayorListConvoys(c, c.req.param())
  )
);
app.get('/api/mayor/:townId/tools/convoys/:convoyId', c =>
  instrumented(c, 'GET /api/mayor/:townId/tools/convoys/:convoyId', () =>
    handleMayorConvoyStatus(c, c.req.param())
  )
);
app.patch('/api/mayor/:townId/tools/rigs/:rigId/beads/:beadId', c =>
  instrumented(c, 'PATCH /api/mayor/:townId/tools/rigs/:rigId/beads/:beadId', () =>
    handleMayorBeadUpdate(c, c.req.param())
  )
);
app.post('/api/mayor/:townId/tools/rigs/:rigId/beads/:beadId/reassign', c =>
  instrumented(c, 'POST /api/mayor/:townId/tools/rigs/:rigId/beads/:beadId/reassign', () =>
    handleMayorBeadReassign(c, c.req.param())
  )
);
app.delete('/api/mayor/:townId/tools/rigs/:rigId/beads/:beadId', c =>
  instrumented(c, 'DELETE /api/mayor/:townId/tools/rigs/:rigId/beads/:beadId', () =>
    handleMayorBeadDelete(c, c.req.param())
  )
);
app.post('/api/mayor/:townId/tools/rigs/:rigId/agents/:agentId/reset', c =>
  instrumented(c, 'POST /api/mayor/:townId/tools/rigs/:rigId/agents/:agentId/reset', () =>
    handleMayorAgentReset(c, c.req.param())
  )
);
app.patch('/api/mayor/:townId/tools/convoys/:convoyId', c =>
  instrumented(c, 'PATCH /api/mayor/:townId/tools/convoys/:convoyId', () =>
    handleMayorConvoyUpdate(c, c.req.param())
  )
);
app.post('/api/mayor/:townId/tools/convoys/:convoyId/close', c =>
  instrumented(c, 'POST /api/mayor/:townId/tools/convoys/:convoyId/close', () =>
    handleMayorConvoyClose(c, c.req.param())
  )
);
app.post('/api/mayor/:townId/tools/escalations/:escalationId/acknowledge', c =>
  instrumented(c, 'POST /api/mayor/:townId/tools/escalations/:escalationId/acknowledge', () =>
    handleMayorEscalationAcknowledge(c, c.req.param())
  )
);
app.post('/api/mayor/:townId/tools/convoys/:convoyId/start', c =>
  handleMayorConvoyStart(c, c.req.param())
);
// ── tRPC ────────────────────────────────────────────────────────────────
// Serve the gastown tRPC router directly. The frontend tRPC client
// connects here instead of going through the Next.js proxy layer.

app.use('/trpc/*', kiloAuthMiddleware);
app.use(
  '/trpc/*',
  trpcServer({
    router: wrappedGastownRouter,
    endpoint: '/trpc',
    createContext: (_opts: unknown, c: Context<GastownEnv>) => ({
      env: c.env,
      userId: c.get('kiloUserId') ?? '',
      isAdmin: c.get('kiloIsAdmin') ?? false,
      apiTokenPepper: c.get('kiloApiTokenPepper') ?? null,
      gastownAccess: c.get('kiloGastownAccess') ?? false,
      orgMemberships: c.get('kiloOrgMemberships') ?? [],
    }),
    onError: ({ error, path }: { error: Error; path?: string }) => {
      console.error(`[gastown-trpc] error on ${path ?? 'unknown'}:`, error.message);
      if (!(error instanceof TRPCError)) {
        Sentry.captureException(error);
      }
    },
  })
);

// ── Error handling ──────────────────────────────────────────────────────

app.notFound(c => c.json(resError('Not found'), 404));

app.onError((err, c) => {
  console.error('Unhandled error', { error: err.message, stack: err.stack });
  Sentry.captureException(err);
  return c.json(resError('Internal server error'), 500);
});

// ── Export with WebSocket interception ───────────────────────────────────
// WebSocket upgrade requests for agent streaming must bypass Hono and go
// directly to the TownContainerDO.fetch(). Hono cannot relay a 101
// WebSocket response — the DO must return the WebSocketPair client end
// directly to the runtime.

const WS_STREAM_PATTERN = /^\/api\/towns\/([^/]+)\/container\/agents\/([^/]+)\/stream$/;
const WS_PTY_PATTERN = /^\/api\/towns\/([^/]+)\/container\/agents\/([^/]+)\/pty\/([^/]+)\/connect$/;
const WS_STATUS_PATTERN = /^\/api\/towns\/([^/]+)\/status\/ws$/;

export default withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN ?? '',
    release: env.SENTRY_RELEASE || env.CF_VERSION_METADATA?.id,
    tracesSampleRate: 0.1,
    enabled: !!env.SENTRY_DSN,
  }),
  {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // Intercept WebSocket upgrade requests for agent streaming and PTY.
      // Must bypass Hono — the DO returns a 101 + WebSocketPair that the
      // runtime handles directly.
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        // WebSocket upgrades use capability-token auth, not JWT headers.
        // Browsers cannot send custom headers on WebSocket connections.
        // The stream endpoint uses a ticket obtained via authenticated POST,
        // and PTY uses a session ID obtained via authenticated POST.
        const url = new URL(request.url);

        // Agent event stream
        const streamMatch = url.pathname.match(WS_STREAM_PATTERN);
        if (streamMatch) {
          const townId = streamMatch[1];
          const agentId = streamMatch[2];
          console.log(`[gastown-worker] WS upgrade (stream): townId=${townId} agentId=${agentId}`);
          const stub = getTownContainerStub(env, townId);
          return stub.fetch(request);
        }

        // PTY terminal connection
        const ptyMatch = url.pathname.match(WS_PTY_PATTERN);
        if (ptyMatch) {
          const townId = ptyMatch[1];
          const agentId = ptyMatch[2];
          const ptyId = ptyMatch[3];
          console.log(
            `[gastown-worker] WS upgrade (pty): townId=${townId} agentId=${agentId} ptyId=${ptyId}`
          );
          const stub = getTownContainerStub(env, townId);
          return stub.fetch(request);
        }

        // Town alarm status (real-time push)
        const statusMatch = url.pathname.match(WS_STATUS_PATTERN);
        if (statusMatch) {
          const townId = statusMatch[1];
          console.log(`[gastown-worker] WS upgrade (status): townId=${townId}`);
          const stub = getTownDOStub(env, townId);
          return stub.fetch(request);
        }
      }

      // All other requests go through Hono
      return app.fetch(request, env, ctx);
    },
  }
);
