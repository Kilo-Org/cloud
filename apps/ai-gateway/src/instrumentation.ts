import { captureRequestError } from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeInstrumentation } =
      await import('@kilocode/web-shared/lib/observability/node-instrumentation');
    registerNodeInstrumentation('kilocode-ai-gateway');
  }
}

export const onRequestError = captureRequestError;

// ci-probe 1

// ci-probe 2

// ci-probe 3
