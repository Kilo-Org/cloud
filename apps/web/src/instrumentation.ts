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
    // Names this app in `x-kilo-caller` on every Bouncer call; BOUNCER_CLIENT_AUTH is checked per
    // call (`bouncer/sts-auth.ts`), and unset sends the legacy key alone. The scopes come from
    // `BOUNCER_APP_SCOPES`, which a test keeps equal to the production grant of `web.yaml`.
    const { installBouncerAuth } = await import('@kilocode/web-shared/lib/bouncer/sts-auth');
    installBouncerAuth('kilocode-app');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = captureRequestError;
