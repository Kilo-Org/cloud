import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { DEFAULT_BACKEND_URL } from './constants.js';
import { logger } from './logger.js';
import type { Env } from './types.js';

/**
 * How a Cloud Agent session for a given model should be billed. Mirrors the
 * source-of-truth classifier in `apps/web`
 * (`lib/cloud-agent-next/classify-model-billing`), which this worker asks over
 * HTTP because it cannot import the app's model catalog.
 */
export type CloudAgentModelBilling = 'free' | 'byok' | 'balance-required';

export type CloudAgentModelBillingOwner =
  | { userId: string; organizationId?: never }
  | { organizationId: string; userId?: never };

/**
 * Result of the single admission round-trip. `balance`/`isDepleted` are only
 * populated when `classification === 'balance-required'` (the only case where
 * balance gates the request); otherwise they are `null`.
 */
export type CloudAgentAdmission = {
  classification: CloudAgentModelBilling;
  balance: number | null;
  isDepleted: boolean | null;
};

const admissionResponseSchema = z.object({
  classification: z.enum(['free', 'byok', 'balance-required']),
  balance: z.number().nullable(),
  isDepleted: z.boolean().nullable(),
});

export const INSUFFICIENT_CREDITS_MESSAGE =
  'Insufficient credits: a positive credit balance is required';

/**
 * Whether a `balance-required` admission must be rejected for lack of funds.
 * Callers gate on `classification === 'balance-required'` first; this mirrors
 * the old worker-side balance check (`isDepleted || balance <= 0`).
 */
export function hasInsufficientBalance(admission: {
  balance: number | null;
  isDepleted: boolean | null;
}): boolean {
  return admission.isDepleted === true || (admission.balance ?? 0) <= 0;
}

const ADMISSION_UNAVAILABLE_MESSAGE = 'Cloud agent admission could not be verified';

/**
 * Fail loud-but-retryable when the backend cannot answer, matching how
 * `assertKiloModelAvailable` treats an unreachable model catalog. Rejecting
 * (rather than silently skipping the balance gate) keeps platform-billed models
 * from being served for free during an outage.
 */
function admissionUnavailable(): TRPCError {
  return new TRPCError({
    code: 'SERVICE_UNAVAILABLE',
    message: ADMISSION_UNAVAILABLE_MESSAGE,
    cause: {
      error: 'CLOUD_AGENT_ADMISSION_UNAVAILABLE',
      message: ADMISSION_UNAVAILABLE_MESSAGE,
      retryable: true,
    },
  });
}

/**
 * Ask `apps/web` whether a model is admissible for the given owner: how it is
 * billed and, when platform-billed, whether the owner has balance. The owner is
 * conveyed the same way the balance check conveyed it — the JWT identifies the
 * user, and `X-KiloCode-OrganizationId` selects the organization owner (whose
 * membership the backend validates).
 */
export async function checkCloudAgentAdmission(params: {
  env: Env;
  token: string;
  modelId: string;
  owner: CloudAgentModelBillingOwner;
}): Promise<CloudAgentAdmission> {
  const backendUrl = params.env.KILOCODE_BACKEND_BASE_URL || DEFAULT_BACKEND_URL;

  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${params.token}`,
  });
  if (params.owner.organizationId) {
    headers.set('X-KiloCode-OrganizationId', params.owner.organizationId);
  }

  let response: Response;
  try {
    response = await fetch(`${backendUrl}/api/profile/cloud-agent-admission`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ modelId: params.modelId }),
    });
  } catch (error) {
    logger
      .withFields({ error: error instanceof Error ? error.message : String(error) })
      .error('Failed to fetch cloud agent admission');
    throw admissionUnavailable();
  }

  if (!response.ok) {
    logger
      .withFields({ status: response.status, statusText: response.statusText })
      .error('Cloud agent admission API returned an error');
    throw admissionUnavailable();
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    logger.error('Cloud agent admission API returned a non-JSON body');
    throw admissionUnavailable();
  }

  const parsed = admissionResponseSchema.safeParse(data);
  if (!parsed.success) {
    logger.error('Cloud agent admission API returned an unexpected shape');
    throw admissionUnavailable();
  }
  return parsed.data;
}
