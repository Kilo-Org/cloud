import type { ClientEvalBilling } from '@kilocode/auto-routing-contracts';
import { INFERENCE_RESERVATION_STATE_HEADER } from '@kilocode/usage-contracts';
import * as z from 'zod';

const AdmissionSchema = z.object({
  kind: z.literal('admitted'),
  reservationId: z.string().optional(),
});

export type JudgeAdmission = 'admitted' | 'insufficient' | 'unavailable';

/**
 * Asks web whether a judged grading call may dispatch. Grading is billed afterward as a separate
 * grader usage row, so a credit hold under this admission identity could never settle: any
 * reservation is released and the call refused.
 */
export async function admitJudgeInference(
  env: Pick<Env, 'INTERNAL_API_SECRET_PROD' | 'KILO_WEB_API_BASE_URL'>,
  billing: ClientEvalBilling,
  request: { model: string; body: unknown }
): Promise<JudgeAdmission> {
  const endpoint = new URL('/api/internal/inference/reservations', env.KILO_WEB_API_BASE_URL);
  const headers = {
    'content-type': 'application/json',
    'x-internal-api-key': await env.INTERNAL_API_SECRET_PROD.get(),
  };
  const identity = {
    requestId: crypto.randomUUID(),
    userId: billing.userId,
    organizationId: billing.organizationId ?? undefined,
  };
  let holdMayExist = true;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'admit',
        ...identity,
        apiKind: 'systemone',
        model: request.model,
        providerId: 'openrouter',
        body: request.body,
      }),
      signal: AbortSignal.timeout(2_000),
    });
    holdMayExist = response.headers.get(INFERENCE_RESERVATION_STATE_HEADER) !== 'none';
    if (!response.ok) {
      await response.body?.cancel();
      return response.status === 402 ? 'insufficient' : 'unavailable';
    }
    const admission = AdmissionSchema.parse(await response.json());
    if (admission.reservationId !== undefined) return 'unavailable';
    holdMayExist = false;
    return 'admitted';
  } catch {
    return 'unavailable';
  } finally {
    if (holdMayExist) await releaseJudgeAdmission(endpoint, headers, identity);
  }
}

async function releaseJudgeAdmission(
  endpoint: URL,
  headers: Record<string, string>,
  identity: { requestId: string; userId: string; organizationId: string | undefined }
): Promise<void> {
  try {
    const released = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'release', ...identity }),
      signal: AbortSignal.timeout(2_000),
    });
    await released.body?.cancel();
    if (!released.ok) throw new Error('Judge admission release unavailable');
  } catch {
    console.error('Judge prepaid admission release requires reconciliation', {
      requestId: identity.requestId,
    });
  }
}
