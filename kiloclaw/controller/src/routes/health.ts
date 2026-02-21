import type { Hono } from 'hono';
import type { Supervisor } from '../supervisor';

export function registerHealthRoute(app: Hono, supervisor: Supervisor): void {
  app.get('/health', c => {
    const stats = supervisor.getStats();
    return c.json({
      status: 'ok',
      gateway: stats.state,
      uptime: stats.uptime,
      restarts: stats.restarts,
    });
  });
}
