import { Hono } from 'hono';

export { RigDO } from './dos/rig-do';
export { TownDO } from './dos/town-do';
export { AgentIdentityDO } from './dos/agent-identity-do';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', c => c.json({ status: 'ok' }));

export default app;
