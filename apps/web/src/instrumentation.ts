import { captureRequestError } from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeInstrumentation } =
      await import('@kilocode/web-shared/lib/observability/node-instrumentation');
    registerNodeInstrumentation('kilocode-app');
    // Node-only, loaded like the instrumentation above so the edge bundle never includes it.
    // Installing builds nothing: SECRETS_SOURCE is checked per read (`sts-secret-reader.ts`).
    const { installSelectedInternalApiSecretRead } =
      await import('@kilocode/web-shared/lib/sts-secret-reader');
    installSelectedInternalApiSecretRead();
    // The credential of the shared auto-routing clients: only this app's switches
    // (`src/lib/auto-routing-sender.ts`). Installing resolves nothing; each switch is read per call.
    const [{ installAutoRoutingSender }, { createWebAutoRoutingSender }] = await Promise.all([
      import('@kilocode/web-shared/lib/ai-gateway/auto-routing-sender'),
      import('./lib/auto-routing-sender'),
    ]);
    installAutoRoutingSender(createWebAutoRoutingSender());
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = captureRequestError;
