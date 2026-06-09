import { WorkerEntrypoint } from 'cloudflare:workers';
import { Hono } from 'hono';
import type { Env } from './env';
import { internalUserEventRoutes } from './internal-user-events';

const app = new Hono<{ Bindings: Env }>();
app.route('/internal', internalUserEventRoutes);

export class InternalUserEventsEntrypoint extends WorkerEntrypoint<Env> {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx);
  }
}
