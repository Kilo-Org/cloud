import { captureRequestError } from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNodeInstrumentation } =
      await import('@/lib/observability/node-instrumentation');
    registerNodeInstrumentation('kilocode-ai-gateway');
  }
}

export const onRequestError = captureRequestError;
