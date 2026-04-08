import { Hono } from 'hono';

export type KiloOpsEnv = {
  Bindings: Env;
  Variables: Record<string, never>;
};

const app = new Hono<KiloOpsEnv>();

app.get('/healthz', c => c.json({ ok: true }));

export default app;