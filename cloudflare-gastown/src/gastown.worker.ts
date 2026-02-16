import { Hono } from 'hono';

export { RigDO } from './dos/Rig.do';
export { TownDO } from './dos/Town.do';
export { AgentIdentityDO } from './dos/AgentIdentity.do';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', c => c.json({ status: 'ok' }));

export default app;
