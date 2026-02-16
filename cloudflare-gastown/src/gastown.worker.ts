import { Hono } from 'hono';
import { resError } from './util/res.util';
import { beadRoutes } from './routes/beads.route';
import { agentRoutes } from './routes/agents.route';
import { mailRoutes } from './routes/mail.route';
import { reviewQueueRoutes } from './routes/review-queue.route';
import { escalationRoutes } from './routes/escalations.route';
import type { AuthVariables } from './middleware/auth.middleware';

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

app.get('/health', c => c.json({ status: 'ok' }));

// Mount route groups
app.route('/api/rigs/:rigId/beads', beadRoutes);
app.route('/api/rigs/:rigId/agents', agentRoutes);
app.route('/api/rigs/:rigId/mail', mailRoutes);
app.route('/api/rigs/:rigId/review-queue', reviewQueueRoutes);
app.route('/api/rigs/:rigId/escalations', escalationRoutes);

app.notFound(c => c.json(resError('Not found'), 404));

app.onError((err, c) => {
  console.error('Unhandled error', { error: err.message, stack: err.stack });
  return c.json(resError('Internal server error'), 500);
});

export default app;
