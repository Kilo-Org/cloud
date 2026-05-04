import { app } from './app';

// Single entry point. No queue consumer, no DOs, no RPC — just the Hono
// app handling /api/model-eval-ingest/*.
export default { fetch: app.fetch };
export { app };
