import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

app.get('/', c => c.json({ ok: true }));

export default { fetch: app.fetch };
