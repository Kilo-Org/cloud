import { Container } from '@cloudflare/containers';
import { Hono } from 'hono';

export type KiloOpsEnv = {
  Bindings: Env;
  Variables: Record<string, never>;
};

export class GrafanaContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = '5m';
}

const app = new Hono<KiloOpsEnv>();

app.get('/healthz', c => c.json({ ok: true }));

export default app;
