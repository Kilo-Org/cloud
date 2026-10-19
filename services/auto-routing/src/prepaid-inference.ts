import { z } from 'zod';
import { INFERENCE_RESERVATION_STATE_HEADER } from '@kilocode/usage-contracts';

type ReservationEnv = {
  INTERNAL_API_SECRET_PROD: { get(): Promise<string> };
  KILO_WEB_API_BASE_URL: string;
};

type ClassifierAdmission =
  | { kind: 'reserved'; reservationId: string; body: Record<string, unknown> }
  | { kind: 'not_required'; body: Record<string, unknown> };

const admissionSchema = z.object({
  kind: z.literal('admitted'),
  reservationId: z.string().uuid().optional(),
  body: z.record(z.string(), z.unknown()),
});

export async function admitClassifierInference(
  env: ReservationEnv,
  input: {
    requestId: string;
    userId: string;
    organizationId: string | null;
    model: string;
    body: unknown;
  }
): Promise<ClassifierAdmission> {
  const endpoint = new URL('/api/internal/inference/reservations', env.KILO_WEB_API_BASE_URL);
  const headers = {
    'content-type': 'application/json',
    'x-internal-api-key': await env.INTERNAL_API_SECRET_PROD.get(),
  };
  const identity = {
    requestId: input.requestId,
    userId: input.userId,
    organizationId: input.organizationId ?? undefined,
  };
  let definitelyNoHold = false;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        action: 'admit',
        ...identity,
        apiKind: 'systemone',
        model: input.model,
        providerId: 'openrouter',
        body: input.body,
      }),
      signal: AbortSignal.timeout(2_000),
    });
    definitelyNoHold = response.headers.get(INFERENCE_RESERVATION_STATE_HEADER) === 'none';
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Classifier prepaid admission rejected');
    }
    const admission = admissionSchema.parse(await response.json());
    if (admission.body.model !== input.model) {
      throw new Error('Classifier prepaid admission model mismatch');
    }
    if (!admission.reservationId) return { kind: 'not_required', body: admission.body };
    if (admission.reservationId !== input.requestId) {
      throw new Error('Classifier prepaid admission identity mismatch');
    }
    return { kind: 'reserved', reservationId: admission.reservationId, body: admission.body };
  } catch (error) {
    if (definitelyNoHold) throw error;
    // No classifier dispatch has happened. The terminal cancellation also fences a late admission.
    try {
      const cancelled = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'release', ...identity }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!cancelled.ok) throw new Error('Classifier cancellation unavailable');
      await cancelled.body?.cancel();
    } catch {
      console.error('Classifier prepaid cancellation requires reconciliation', {
        requestId: input.requestId,
      });
    }
    throw error;
  }
}
