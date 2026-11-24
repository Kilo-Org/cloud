import {
  AUTO_ROUTING_INPUT_GUARDRAIL_PATH,
  type AutoRoutingInputGuardrailRequest,
} from '@kilocode/auto-routing-contracts';
import * as z from 'zod';
import { CustomRouterError, DEPENDENCY_RETRY_AFTER_SECONDS } from './caller-auth';

const RejectionSchema = z.object({
  error_type: z.enum(['guardrail_blocked', 'guardrail_unavailable']),
  error: z.object({ message: z.string() }),
});

export async function checkDecideInputGuardrail(
  env: Env,
  request: AutoRoutingInputGuardrailRequest,
  signal: AbortSignal
) {
  const unavailable = () =>
    new CustomRouterError(
      'internal_error',
      'Organization input guardrail is temporarily unavailable',
      DEPENDENCY_RETRY_AFTER_SECONDS
    );
  // Give the gateway's 60s scan budget time to return its own verdict. A transport failure is
  // not an allow verdict. Do not automatically repeat a potentially billable scan.
  let response: Response;
  try {
    response = await fetch(
      new URL(AUTO_ROUTING_INPUT_GUARDRAIL_PATH, env.KILO_AI_GATEWAY_BASE_URL),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await env.INTERNAL_API_SECRET_PROD.get()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]),
      }
    );
  } catch {
    throw unavailable();
  }
  if (response.status === 204) return;
  if (response.status === 402)
    throw new CustomRouterError('insufficient_balance', 'Insufficient balance');
  if (response.status === 413)
    throw new CustomRouterError(
      'invalid_request',
      'Conversation is too large for the organization input guardrail'
    );
  const rejection = RejectionSchema.safeParse(await response.json().catch(() => null));
  if (!rejection.success) throw unavailable();
  throw new CustomRouterError(
    rejection.data.error_type === 'guardrail_blocked' ? 'forbidden' : 'internal_error',
    rejection.data.error.message,
    response.headers.has('retry-after') ? DEPENDENCY_RETRY_AFTER_SECONDS : null
  );
}
