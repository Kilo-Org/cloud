import { Hono } from 'hono';
import * as Sentry from '@sentry/cloudflare';
import { createErrorHandler, createNotFoundHandler } from '@kilocode/worker-utils';
import type { HonoEnv } from './types.js';
import { handleChatCompletions } from './routes/chat-completions.js';

const app = new Hono<HonoEnv>();

// Routes — same paths as Next.js for seamless cutover
app.post('/api/gateway/chat/completions', handleChatCompletions);
app.post('/api/openrouter/chat/completions', handleChatCompletions);

// Health check
app.get('/health', c => c.json({ status: 'ok' }));

// Error handling
app.onError(createErrorHandler());
app.notFound(createNotFoundHandler());

// Sentry-wrapped export
export default Sentry.withSentry(
  (env: HonoEnv['Bindings']) => ({
    dsn: env.SENTRY_DSN,
    release: env.CF_VERSION_METADATA?.id,
    environment: env.ENVIRONMENT || 'production',
  }),
  app
);
