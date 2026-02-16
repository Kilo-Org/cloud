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
} from './handlers/beads.handler';
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
import { handleSendMail } from './handlers/mail.handler';
import { handleSubmitToReviewQueue } from './handlers/review-queue.handler';
import { handleCreateEscalation } from './handlers/escalations.handler';

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

app.post('/api/rigs/:rigId/beads', c => handleCreateBead(c, { rigId: c.req.param('rigId') }));
app.get('/api/rigs/:rigId/beads', c => handleListBeads(c, { rigId: c.req.param('rigId') }));
app.get('/api/rigs/:rigId/beads/:beadId', c =>
  handleGetBead(c, { rigId: c.req.param('rigId'), beadId: c.req.param('beadId') })
);
app.patch('/api/rigs/:rigId/beads/:beadId/status', c =>
  handleUpdateBeadStatus(c, { rigId: c.req.param('rigId'), beadId: c.req.param('beadId') })
);
app.post('/api/rigs/:rigId/beads/:beadId/close', c =>
  handleCloseBead(c, { rigId: c.req.param('rigId'), beadId: c.req.param('beadId') })
);

// ── Agents ──────────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/agents', c => handleRegisterAgent(c, { rigId: c.req.param('rigId') }));
app.get('/api/rigs/:rigId/agents', c => handleListAgents(c, { rigId: c.req.param('rigId') }));
app.get('/api/rigs/:rigId/agents/:agentId', c =>
  handleGetAgent(c, { rigId: c.req.param('rigId'), agentId: c.req.param('agentId') })
);

// Agent-scoped routes (agentOnlyMiddleware enforces JWT agentId match)
app.post('/api/rigs/:rigId/agents/:agentId/hook', agentOnlyMiddleware, c =>
  handleHookBead(c, { rigId: c.req.param('rigId'), agentId: c.req.param('agentId') })
);
app.delete('/api/rigs/:rigId/agents/:agentId/hook', agentOnlyMiddleware, c =>
  handleUnhookBead(c, { rigId: c.req.param('rigId'), agentId: c.req.param('agentId') })
);
app.get('/api/rigs/:rigId/agents/:agentId/prime', agentOnlyMiddleware, c =>
  handlePrime(c, { rigId: c.req.param('rigId'), agentId: c.req.param('agentId') })
);
app.post('/api/rigs/:rigId/agents/:agentId/done', agentOnlyMiddleware, c =>
  handleAgentDone(c, { rigId: c.req.param('rigId'), agentId: c.req.param('agentId') })
);
app.post('/api/rigs/:rigId/agents/:agentId/checkpoint', agentOnlyMiddleware, c =>
  handleWriteCheckpoint(c, { rigId: c.req.param('rigId'), agentId: c.req.param('agentId') })
);
app.get('/api/rigs/:rigId/agents/:agentId/mail', agentOnlyMiddleware, c =>
  handleCheckMail(c, { rigId: c.req.param('rigId'), agentId: c.req.param('agentId') })
);

// ── Mail ────────────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/mail', c => handleSendMail(c, { rigId: c.req.param('rigId') }));

// ── Review Queue ────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/review-queue', c =>
  handleSubmitToReviewQueue(c, { rigId: c.req.param('rigId') })
);

// ── Escalations ─────────────────────────────────────────────────────────

app.post('/api/rigs/:rigId/escalations', c =>
  handleCreateEscalation(c, { rigId: c.req.param('rigId') })
);

// ── Error handling ──────────────────────────────────────────────────────

app.notFound(c => c.json(resError('Not found'), 404));

app.onError((err, c) => {
  console.error('Unhandled error', { error: err.message, stack: err.stack });
  return c.json(resError('Internal server error'), 500);
});

export default app;
