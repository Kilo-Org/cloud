import { Hono } from 'hono';
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
import { handleSubmitToReviewQueue } from './handlers/rig-review-queue.handler';
import { handleCreateEscalation } from './handlers/rig-escalations.handler';
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
  handleDestroyMayor,
} from './handlers/mayor.handler';

export { RigDO } from './dos/Rig.do';
export { GastownUserDO } from './dos/GastownUser.do';
export { AgentIdentityDO } from './dos/AgentIdentity.do';
export { TownContainerDO } from './dos/TownContainer.do';
export { MayorDO } from './dos/Mayor.do';

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
// Applied at /api/rigs/:rigId/* so the rigId param is in scope for JWT validation.
// Skipped in development to allow the dashboard and local tooling to work without JWTs.

app.use('/api/rigs/:rigId/*', async (c, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : authMiddleware(c, next)
);

// ── Beads ───────────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/beads', c => handleCreateBead(c, c.req.param()));
app.get('/api/rigs/:rigId/beads', c => handleListBeads(c, c.req.param()));
app.get('/api/rigs/:rigId/beads/:beadId', c => handleGetBead(c, c.req.param()));
app.patch('/api/rigs/:rigId/beads/:beadId/status', c => handleUpdateBeadStatus(c, c.req.param()));
app.post('/api/rigs/:rigId/beads/:beadId/close', c => handleCloseBead(c, c.req.param()));
app.post('/api/rigs/:rigId/sling', c => handleSlingBead(c, c.req.param()));
app.delete('/api/rigs/:rigId/beads/:beadId', c => handleDeleteBead(c, c.req.param()));

// ── Agents ──────────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/agents', c => handleRegisterAgent(c, c.req.param()));
app.get('/api/rigs/:rigId/agents', c => handleListAgents(c, c.req.param()));
app.post('/api/rigs/:rigId/agents/get-or-create', c => handleGetOrCreateAgent(c, c.req.param()));
app.get('/api/rigs/:rigId/agents/:agentId', c => handleGetAgent(c, c.req.param()));
app.delete('/api/rigs/:rigId/agents/:agentId', c => handleDeleteAgent(c, c.req.param()));

// Agent-scoped routes — agentOnlyMiddleware enforces JWT agentId match
app.use('/api/rigs/:rigId/agents/:agentId/*', async (c, next) =>
  c.env.ENVIRONMENT === 'development' ? next() : agentOnlyMiddleware(c, next)
);
app.post('/api/rigs/:rigId/agents/:agentId/hook', c => handleHookBead(c, c.req.param()));
app.delete('/api/rigs/:rigId/agents/:agentId/hook', c => handleUnhookBead(c, c.req.param()));
app.get('/api/rigs/:rigId/agents/:agentId/prime', c => handlePrime(c, c.req.param()));
app.post('/api/rigs/:rigId/agents/:agentId/done', c => handleAgentDone(c, c.req.param()));
app.post('/api/rigs/:rigId/agents/:agentId/completed', c => handleAgentCompleted(c, c.req.param()));
app.post('/api/rigs/:rigId/agents/:agentId/checkpoint', c =>
  handleWriteCheckpoint(c, c.req.param())
);
app.get('/api/rigs/:rigId/agents/:agentId/mail', c => handleCheckMail(c, c.req.param()));
app.post('/api/rigs/:rigId/agents/:agentId/heartbeat', c => handleHeartbeat(c, c.req.param()));

// ── Mail ────────────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/mail', c => handleSendMail(c, c.req.param()));

// ── Review Queue ────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/review-queue', c => handleSubmitToReviewQueue(c, c.req.param()));

// ── Escalations ─────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/escalations', c => handleCreateEscalation(c, c.req.param()));

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
app.get('/api/towns/:townId/container/health', c => handleContainerHealth(c, c.req.param()));

// ── Mayor ────────────────────────────────────────────────────────────────
// MayorDO endpoints — town-level conversational agent with persistent session.

app.post('/api/towns/:townId/mayor/configure', c => handleConfigureMayor(c, c.req.param()));
app.post('/api/towns/:townId/mayor/message', c => handleSendMayorMessage(c, c.req.param()));
app.get('/api/towns/:townId/mayor/status', c => handleGetMayorStatus(c, c.req.param()));
app.post('/api/towns/:townId/mayor/destroy', c => handleDestroyMayor(c, c.req.param()));

// ── Error handling ──────────────────────────────────────────────────────

app.notFound(c => c.json(resError('Not found'), 404));

app.onError((err, c) => {
  console.error('Unhandled error', { error: err.message, stack: err.stack });
  return c.json(resError('Internal server error'), 500);
});

export default app;
