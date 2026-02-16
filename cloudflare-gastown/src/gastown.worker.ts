import { Hono } from 'hono';
import { resError } from './util/res.util';
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
} from './handlers/rig-beads.handler';
import {
  handleRegisterAgent,
  handleListAgents,
  handleGetAgent,
  handleHookBead,
  handleUnhookBead,
  handlePrime,
  handleAgentDone,
  handleWriteCheckpoint,
  handleCheckMail,
} from './handlers/rig-agents.handler';
import { handleSendMail } from './handlers/rig-mail.handler';
import { handleSubmitToReviewQueue } from './handlers/rig-review-queue.handler';
import { handleCreateEscalation } from './handlers/rig-escalations.handler';

export { RigDO } from './dos/Rig.do';
export { TownDO } from './dos/Town.do';
export { AgentIdentityDO } from './dos/AgentIdentity.do';

// Extend the generated Env with secrets store bindings.
// The generated worker-configuration.d.ts only contains DO namespace bindings;
// secrets_store_secrets bindings must be declared manually until `wrangler types`
// is re-run after the wrangler.jsonc change.
// In production, secrets are SecretsStoreSecret (with .get()); in tests they're plain strings
type GastownSecrets = {
  INTERNAL_API_SECRET: SecretsStoreSecret | string;
  GASTOWN_JWT_SECRET: SecretsStoreSecret | string;
};

export type GastownEnv = {
  Bindings: Env & GastownSecrets;
  Variables: AuthVariables;
};

const app = new Hono<GastownEnv>();

// ── Health ──────────────────────────────────────────────────────────────

app.get('/health', c => c.json({ status: 'ok' }));

// ── Auth ────────────────────────────────────────────────────────────────
// Applied at /api/rigs/:rigId/* so the rigId param is in scope for JWT validation.

app.use('/api/rigs/:rigId/*', authMiddleware);

// ── Beads ───────────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/beads', c => handleCreateBead(c, c.req.param()));
app.get('/api/rigs/:rigId/beads', c => handleListBeads(c, c.req.param()));
app.get('/api/rigs/:rigId/beads/:beadId', c => handleGetBead(c, c.req.param()));
app.patch('/api/rigs/:rigId/beads/:beadId/status', c => handleUpdateBeadStatus(c, c.req.param()));
app.post('/api/rigs/:rigId/beads/:beadId/close', c => handleCloseBead(c, c.req.param()));

// ── Agents ──────────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/agents', c => handleRegisterAgent(c, c.req.param()));
app.get('/api/rigs/:rigId/agents', c => handleListAgents(c, c.req.param()));
app.get('/api/rigs/:rigId/agents/:agentId', c => handleGetAgent(c, c.req.param()));

// Agent-scoped routes — agentOnlyMiddleware enforces JWT agentId match
app.use('/api/rigs/:rigId/agents/:agentId/*', agentOnlyMiddleware);
app.post('/api/rigs/:rigId/agents/:agentId/hook', c => handleHookBead(c, c.req.param()));
app.delete('/api/rigs/:rigId/agents/:agentId/hook', c => handleUnhookBead(c, c.req.param()));
app.get('/api/rigs/:rigId/agents/:agentId/prime', c => handlePrime(c, c.req.param()));
app.post('/api/rigs/:rigId/agents/:agentId/done', c => handleAgentDone(c, c.req.param()));
app.post('/api/rigs/:rigId/agents/:agentId/checkpoint', c =>
  handleWriteCheckpoint(c, c.req.param())
);
app.get('/api/rigs/:rigId/agents/:agentId/mail', c => handleCheckMail(c, c.req.param()));

// ── Mail ────────────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/mail', c => handleSendMail(c, c.req.param()));

// ── Review Queue ────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/review-queue', c => handleSubmitToReviewQueue(c, c.req.param()));

// ── Escalations ─────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/escalations', c => handleCreateEscalation(c, c.req.param()));

// ── Error handling ──────────────────────────────────────────────────────

app.notFound(c => c.json(resError('Not found'), 404));

app.onError((err, c) => {
  console.error('Unhandled error', { error: err.message, stack: err.stack });
  return c.json(resError('Internal server error'), 500);
});

export default app;
