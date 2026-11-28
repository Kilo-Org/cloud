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
    // The credential of the shared auto-routing clients: only this app's switches
    // (`auto-routing-gateway-sender.ts`), resolved once here, when the sender is built.
    const [{ installAutoRoutingSender }, { createGatewayAutoRoutingSender }] = await Promise.all([
      import('@kilocode/web-shared/lib/ai-gateway/auto-routing-sender'),
      import('@kilocode/web-shared/lib/ai-gateway/auto-routing-gateway-sender'),
    ]);
    installAutoRoutingSender(createGatewayAutoRoutingSender());
  }
}

export const onRequestError = captureRequestError;
