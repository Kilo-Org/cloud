import { captureRequestError } from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeInstrumentation } =
      await import('@kilocode/web-shared/lib/observability/node-instrumentation');
    registerNodeInstrumentation('kilocode-app');
    // Node-only, loaded like the instrumentation above so the edge bundle never includes it.
    // Installing builds nothing: SECRETS_SOURCE is checked per read (`sts-secret-reader.ts`).
    const { installWebInternalApiSecretRead } = await import('@/lib/sts-secret-reader');
    installWebInternalApiSecretRead();
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = captureRequestError;
