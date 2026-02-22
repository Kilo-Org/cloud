import { Hono } from 'hono';
import { getTownContainerStub } from './dos/TownContainer.do';
import { resError } from './util/res.util';
import { dashboardHtml } from './ui/dashboard.ui';
import { withCloudflareAccess } from './middleware/cf-access.middleware';
import {
  authMiddleware,
  agentOnlyMiddleware,
  type AuthVariables,
} from './middleware/auth.middleware';
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
  handleAgentCompleted,
  handleWriteCheckpoint,
  handleCheckMail,
  handleHeartbeat,
  handleGetOrCreateAgent,
  handleDeleteAgent,
} from './handlers/rig-agents.handler';
import { handleSendMail } from './handlers/rig-mail.handler';
import { handleAppendAgentEvent, handleGetAgentEvents } from './handlers/rig-agent-events.handler';
import {
  handleSubmitToReviewQueue,
  handleCompleteReview,
} from './handlers/rig-review-queue.handler';
import { handleCreateEscalation } from './handlers/rig-escalations.handler';
import { handleListBeadEvents } from './handlers/rig-bead-events.handler';
import { handleListTownEvents } from './handlers/town-events.handler';
import {
  handleContainerStartAgent,
  handleContainerStopAgent,
  handleContainerSendMessage,
  handleContainerAgentStatus,
  handleContainerStreamTicket,
  handleContainerHealth,
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
  handleConfigureMayor,
  handleSendMayorMessage,
  handleGetMayorStatus,
  handleMayorCompleted,
  handleDestroyMayor,
} from './handlers/mayor.handler';
import {
  handleMayorSling,
  handleMayorListRigs,
  handleMayorListBeads,
  handleMayorListAgents,
  handleMayorSendMail,
} from './handlers/mayor-tools.handler';
import { mayorAuthMiddleware } from './middleware/mayor-auth.middleware';
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

export { GastownUserDO } from './dos/GastownUser.do';
export { AgentIdentityDO } from './dos/AgentIdentity.do';
export { TownDO } from './dos/Town.do';
export { TownContainerDO } from './dos/TownContainer.do';
export { AgentDO } from './dos/Agent.do';

export type GastownEnv = {
  Bindings: Env;
  Variables: AuthVariables;
};

const app = new Hono<GastownEnv>();

const WORKER_LOG = '[gastown-worker]';

// ── Request logging ─────────────────────────────────────────────────────
app.use('*', async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;
  const startTime = Date.now();
  console.log(`${WORKER_LOG} --> ${method} ${path}`);
  await next();
  const elapsed = Date.now() - startTime;
  console.log(`${WORKER_LOG} <-- ${method} ${path} ${c.res.status} (${elapsed}ms)`);
});

// ── Cloudflare Access ───────────────────────────────────────────────────
// Validate Cloudflare Access JWT for all requests; skip in development.

app.use('*', async (c, next) =>
  c.env.ENVIRONMENT === 'development'
    ? next()
    : withCloudflareAccess({
        team: c.env.CF_ACCESS_TEAM,
        audience: c.env.CF_ACCESS_AUD,
      })(c, next)
);

// ── Dashboard UI ────────────────────────────────────────────────────────

app.get('/', c => c.html(dashboardHtml()));

// ── Health ──────────────────────────────────────────────────────────────

app.get('/health', c => c.json({ status: 'ok' }));

// ── Auth ────────────────────────────────────────────────────────────────
// All rig routes live under /api/towns/:townId/rigs/:rigId so the townId
// is always available from the URL path. Auth middleware skipped in dev.

app.use('/api/towns/:townId/rigs/:rigId/*', async (c, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : authMiddleware(c, next)
);

// ── Beads ───────────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/beads', c => handleCreateBead(c, c.req.param()));
app.get('/api/towns/:townId/rigs/:rigId/beads', c => handleListBeads(c, c.req.param()));
app.get('/api/towns/:townId/rigs/:rigId/beads/:beadId', c => handleGetBead(c, c.req.param()));
app.patch('/api/towns/:townId/rigs/:rigId/beads/:beadId/status', c =>
  handleUpdateBeadStatus(c, c.req.param())
);
app.post('/api/towns/:townId/rigs/:rigId/beads/:beadId/close', c =>
  handleCloseBead(c, c.req.param())
);
app.post('/api/towns/:townId/rigs/:rigId/sling', c => handleSlingBead(c, c.req.param()));
app.delete('/api/towns/:townId/rigs/:rigId/beads/:beadId', c => handleDeleteBead(c, c.req.param()));

// ── Agents ──────────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/agents', c => handleRegisterAgent(c, c.req.param()));
app.get('/api/towns/:townId/rigs/:rigId/agents', c => handleListAgents(c, c.req.param()));
app.post('/api/towns/:townId/rigs/:rigId/agents/get-or-create', c =>
  handleGetOrCreateAgent(c, c.req.param())
);
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId', c => handleGetAgent(c, c.req.param()));
app.delete('/api/towns/:townId/rigs/:rigId/agents/:agentId', c =>
  handleDeleteAgent(c, c.req.param())
);

// Dashboard-accessible agent events (before agentOnlyMiddleware so the
// frontend can query events without an agent JWT)
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId/events', c =>
  handleGetAgentEvents(c, c.req.param())
);

// Agent-scoped routes — agentOnlyMiddleware enforces JWT agentId match
app.use('/api/towns/:townId/rigs/:rigId/agents/:agentId/*', async (c, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : agentOnlyMiddleware(c, next)
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/hook', c =>
  handleHookBead(c, c.req.param())
);
app.delete('/api/towns/:townId/rigs/:rigId/agents/:agentId/hook', c =>
  handleUnhookBead(c, c.req.param())
);
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId/prime', c => handlePrime(c, c.req.param()));
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/done', c =>
  handleAgentDone(c, c.req.param())
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/completed', c =>
  handleAgentCompleted(c, c.req.param())
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/checkpoint', c =>
  handleWriteCheckpoint(c, c.req.param())
);
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId/mail', c =>
  handleCheckMail(c, c.req.param())
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/heartbeat', c =>
  handleHeartbeat(c, c.req.param())
);

// ── Agent Events ─────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/agent-events', c =>
  handleAppendAgentEvent(c, c.req.param())
);

// ── Mail ────────────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/mail', c => handleSendMail(c, c.req.param()));

// ── Review Queue ────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/review-queue', c =>
  handleSubmitToReviewQueue(c, c.req.param())
);
app.post('/api/towns/:townId/rigs/:rigId/review-queue/:entryId/complete', c =>
  handleCompleteReview(c, c.req.param())
);

// ── Bead Events ─────────────────────────────────────────────────────────

app.get('/api/towns/:townId/rigs/:rigId/events', c => handleListBeadEvents(c, c.req.param()));

// ── Molecules ────────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/molecules', c => handleCreateMolecule(c, c.req.param()));
app.get('/api/towns/:townId/rigs/:rigId/agents/:agentId/molecule/current', c =>
  handleGetMoleculeCurrentStep(c, c.req.param())
);
app.post('/api/towns/:townId/rigs/:rigId/agents/:agentId/molecule/advance', c =>
  handleAdvanceMoleculeStep(c, c.req.param())
);

// ── Escalations ─────────────────────────────────────────────────────────

app.post('/api/towns/:townId/rigs/:rigId/escalations', c =>
  handleCreateEscalation(c, c.req.param())
);

// ── Towns & Rigs ────────────────────────────────────────────────────────
// Town DO instances are keyed by owner_user_id. The userId path param routes
// to the correct DO instance so each user's towns are isolated.

app.post('/api/users/:userId/towns', c => handleCreateTown(c, c.req.param()));
app.get('/api/users/:userId/towns', c => handleListTowns(c, c.req.param()));
app.get('/api/users/:userId/towns/:townId', c => handleGetTown(c, c.req.param()));
app.post('/api/users/:userId/rigs', c => handleCreateRig(c, c.req.param()));
app.get('/api/users/:userId/rigs/:rigId', c => handleGetRig(c, c.req.param()));
app.get('/api/users/:userId/towns/:townId/rigs', c => handleListRigs(c, c.req.param()));
app.delete('/api/users/:userId/towns/:townId', c => handleDeleteTown(c, c.req.param()));
app.delete('/api/users/:userId/rigs/:rigId', c => handleDeleteRig(c, c.req.param()));

// ── Town Convoys ─────────────────────────────────────────────────────────

app.post('/api/towns/:townId/convoys', c => handleCreateConvoy(c, c.req.param()));
app.post('/api/towns/:townId/convoys/bead-closed', c => handleOnBeadClosed(c, c.req.param()));

// ── Town Escalations ─────────────────────────────────────────────────────

app.get('/api/towns/:townId/escalations', c => handleListEscalations(c, c.req.param()));
app.post('/api/towns/:townId/escalations/:escalationId/acknowledge', c =>
  handleAcknowledgeEscalation(c, c.req.param())
);

// ── Town Configuration ──────────────────────────────────────────────────

app.get('/api/towns/:townId/config', c => handleGetTownConfig(c, c.req.param()));
app.patch('/api/towns/:townId/config', c => handleUpdateTownConfig(c, c.req.param()));

// ── Town Events ─────────────────────────────────────────────────────────

app.get('/api/users/:userId/towns/:townId/events', c => handleListTownEvents(c, c.req.param()));

// ── Town Container ──────────────────────────────────────────────────────
// These routes proxy commands to the container's control server via DO.fetch().
// Protected by Cloudflare Access at the perimeter; no additional auth required.

app.post('/api/towns/:townId/container/agents/start', c =>
  handleContainerStartAgent(c, c.req.param())
);
app.post('/api/towns/:townId/container/agents/:agentId/stop', c =>
  handleContainerStopAgent(c, c.req.param())
);
app.post('/api/towns/:townId/container/agents/:agentId/message', c =>
  handleContainerSendMessage(c, c.req.param())
);
app.get('/api/towns/:townId/container/agents/:agentId/status', c =>
  handleContainerAgentStatus(c, c.req.param())
);
app.post('/api/towns/:townId/container/agents/:agentId/stream-ticket', c =>
  handleContainerStreamTicket(c, c.req.param())
);
// Note: GET /api/towns/:townId/container/agents/:agentId/stream (WebSocket)
// is handled outside Hono in the default export's fetch handler, which
// routes the upgrade directly to TownContainerDO.fetch().

app.get('/api/towns/:townId/container/health', c => handleContainerHealth(c, c.req.param()));

// ── Mayor ────────────────────────────────────────────────────────────────
// MayorDO endpoints — town-level conversational agent with persistent session.

app.post('/api/towns/:townId/mayor/configure', c => handleConfigureMayor(c, c.req.param()));
app.post('/api/towns/:townId/mayor/message', c => handleSendMayorMessage(c, c.req.param()));
app.get('/api/towns/:townId/mayor/status', c => handleGetMayorStatus(c, c.req.param()));
app.post('/api/towns/:townId/mayor/completed', c => handleMayorCompleted(c, c.req.param()));
app.post('/api/towns/:townId/mayor/destroy', c => handleDestroyMayor(c, c.req.param()));

// ── Mayor Tools ──────────────────────────────────────────────────────────
// Tool endpoints called by the mayor's kilo serve session via the Gastown plugin.
// Authenticated via mayor JWT (townId-scoped, no rigId restriction).

// Always run mayor auth — even in dev. The handler's resolveUserId()
// reads agentJWT.userId which is only set after the middleware parses
// the token. Skipping auth in dev leaves agentJWT null and causes 401s
// from the handler itself.
app.use('/api/mayor/:townId/tools/*', mayorAuthMiddleware);

app.post('/api/mayor/:townId/tools/sling', c => handleMayorSling(c, c.req.param()));
app.get('/api/mayor/:townId/tools/rigs', c => handleMayorListRigs(c, c.req.param()));
app.get('/api/mayor/:townId/tools/rigs/:rigId/beads', c => handleMayorListBeads(c, c.req.param()));
app.get('/api/mayor/:townId/tools/rigs/:rigId/agents', c =>
  handleMayorListAgents(c, c.req.param())
);
app.post('/api/mayor/:townId/tools/mail', c => handleMayorSendMail(c, c.req.param()));

// ── Error handling ──────────────────────────────────────────────────────

app.notFound(c => c.json(resError('Not found'), 404));

app.onError((err, c) => {
  console.error('Unhandled error', { error: err.message, stack: err.stack });
  return c.json(resError('Internal server error'), 500);
});

// ── Export with WebSocket interception ───────────────────────────────────
// WebSocket upgrade requests for agent streaming must bypass Hono and go
// directly to the TownContainerDO.fetch(). Hono cannot relay a 101
// WebSocket response — the DO must return the WebSocketPair client end
// directly to the runtime.

const WS_STREAM_PATTERN = /^\/api\/towns\/([^/]+)\/container\/agents\/([^/]+)\/stream$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Intercept WebSocket upgrade requests for agent streaming.
    // Must bypass Hono — the DO returns a 101 + WebSocketPair that the
    // runtime handles directly.
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const url = new URL(request.url);
      const match = url.pathname.match(WS_STREAM_PATTERN);
      if (match) {
        const townId = match[1];
        const agentId = match[2];
        console.log(`[gastown-worker] WS upgrade: townId=${townId} agentId=${agentId}`);
        // Pass the original request to the DO — the CF runtime needs the
        // original Request object to handle the WebSocket upgrade.
        const stub = getTownContainerStub(env, townId);
        return stub.fetch(request);
      }
    }

    // All other requests go through Hono
    return app.fetch(request, env, ctx);
  },
};
