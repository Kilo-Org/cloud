import { captureRequestError } from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeInstrumentation } =
      await import('@kilocode/web-shared/lib/observability/node-instrumentation');
    registerNodeInstrumentation('kilocode-ai-gateway');
    // Node-only, loaded like the instrumentation above. Installing builds nothing: SECRETS_SOURCE
    // is checked per read (`sts-secret-reader.ts`), and unset keeps `INTERNAL_API_SECRET`.
    const { installSelectedInternalApiSecretRead } =
      await import('@kilocode/web-shared/lib/sts-secret-reader');
    installSelectedInternalApiSecretRead();
  }
}

export const onRequestError = captureRequestError;
