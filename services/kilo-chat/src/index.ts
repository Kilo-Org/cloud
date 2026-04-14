import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';

const app = new Hono<{ Bindings: Env }>();

app.get('/health', c => c.json({ ok: true }));

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }
}
