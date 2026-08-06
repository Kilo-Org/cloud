import 'server-only';

import { timingSafeEqual } from 'node:crypto';

import { createGateway, generateText } from 'ai';
import type { GatewayProviderOptions } from '@ai-sdk/gateway';

import { UserByokTestModels } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { createAiSdkProvider } from '@/lib/ai-gateway/providers/direct-byok';
import byteplusCoding from '@/lib/ai-gateway/providers/direct-byok/byteplus-coding';
import { getVercelInferenceProviderConfigForUserByok } from '@/lib/ai-gateway/providers/vercel';
import {
  BYTEPLUS_CODING_PLAN_ACCESS_KEY_ID,
  BYTEPLUS_CODING_PLAN_SECRET_ACCESS_KEY,
} from '@/lib/config.server';
import {
  BytePlusControlPlaneError,
  listBytePlusSeatsByUsername,
} from '@/lib/coding-plans/byteplus-control-plane';
import type { CodingPlanId, CodingPlanProviderId } from '@/lib/coding-plans/pricing';
import { getCodingPlanPrice } from '@/lib/coding-plans/pricing';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import { sentryLogger } from '@/lib/utils.server';

const logWarning = sentryLogger('coding-plans-inventory-validation', 'warning');
const MINIMAX_PROVIDER_ID = 'minimax';

export type CodingPlanCredentialValidationInput = {
  apiKey: string;
  planId: CodingPlanId;
  providerId: CodingPlanProviderId;
  upstreamPlanId: string;
};

export type CodingPlanCredentialValidationResult = {
  valid: boolean;
  upstreamUsageId?: string;
};

async function validateMiniMaxCodingPlanCredential(
  apiKey: string
): Promise<CodingPlanCredentialValidationResult> {
  const [finalProvider, byokList] = getVercelInferenceProviderConfigForUserByok({
    providerId: MINIMAX_PROVIDER_ID,
    decryptedAPIKey: apiKey,
  });

  const output = await generateText({
    model: createGateway({ apiKey: PROVIDERS.VERCEL_AI_GATEWAY.apiKey })(
      UserByokTestModels[MINIMAX_PROVIDER_ID]
    ),
    prompt: 'Say hi',
    maxOutputTokens: 1,
    providerOptions: {
      gateway: {
        only: [finalProvider],
        byok: { [finalProvider]: byokList },
      } satisfies GatewayProviderOptions,
    },
  });

  return {
    valid: output.finishReason === 'stop' || output.finishReason === 'length',
  };
}

async function validateBytePlusCodingPlanCredential(
  apiKey: string,
  planId: CodingPlanId,
  upstreamUsername: string
): Promise<CodingPlanCredentialValidationResult> {
  if (!BYTEPLUS_CODING_PLAN_ACCESS_KEY_ID || !BYTEPLUS_CODING_PLAN_SECRET_ACCESS_KEY) {
    throw new BytePlusControlPlaneError('configuration');
  }

  const output = await generateText({
    model: createAiSdkProvider(byteplusCoding, apiKey)('bytedance-seed-code'),
    prompt: 'Say hi',
    maxOutputTokens: 1,
  });

  if (output.finishReason !== 'stop' && output.finishReason !== 'length') {
    return { valid: false };
  }

  const upstreamUsageId = await resolveBytePlusSeatId({
    apiKey,
    planId,
    upstreamUsername,
  });
  return upstreamUsageId ? { valid: true, upstreamUsageId } : { valid: false };
}

export async function resolveBytePlusSeatId(input: {
  apiKey: string;
  planId: CodingPlanId;
  upstreamUsername: string;
}): Promise<string | null> {
  const expectedTier = getBytePlusPlanTier(input.planId);
  if (!expectedTier) return null;

  const seats = await listBytePlusSeatsByUsername({
    username: input.upstreamUsername,
    bizInfo: expectedTier,
  });
  if (seats.length !== 1) return null;

  const [seat] = seats;
  if (seat.bizInfo !== expectedTier || seat.seatStatus !== 2 || seat.billingStatus !== 2) {
    return null;
  }

  // A missing or masked provider key cannot prove that the uploaded inference
  // key belongs to this seat. Fail closed until BytePlus exposes a safe key
  // identity that can be supplied with inventory instead.
  if (!seat.apiKey || !constantTimeEqual(seat.apiKey, input.apiKey)) return null;

  return seat.seatId;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export async function validateCodingPlanCredential({
  apiKey,
  planId,
  providerId,
  upstreamPlanId,
}: CodingPlanCredentialValidationInput): Promise<CodingPlanCredentialValidationResult> {
  try {
    switch (providerId) {
      case 'minimax':
        return await validateMiniMaxCodingPlanCredential(apiKey);
      case 'byteplus-coding':
        return await validateBytePlusCodingPlanCredential(apiKey, planId, upstreamPlanId);
      default:
        return { valid: false };
    }
  } catch (error) {
    logWarning('Coding plan inventory credential validation failed', {
      providerId,
      code: error instanceof BytePlusControlPlaneError ? error.code : 'validation_failed',
    });
    return { valid: false };
  }
}

export function isCodingPlanCredentialValidationSuccessful(
  result: CodingPlanCredentialValidationResult | boolean
): result is CodingPlanCredentialValidationResult {
  return typeof result === 'boolean' ? result : result.valid === true;
}

export function getCodingPlanValidationResult(
  result: CodingPlanCredentialValidationResult | boolean
): CodingPlanCredentialValidationResult {
  return typeof result === 'boolean' ? { valid: result } : result;
}

export function getBytePlusPlanTier(planId: CodingPlanId): 'Lite' | 'Pro' | null {
  const plan = getCodingPlanPrice(planId);
  if (plan?.providerId !== 'byteplus-coding') return null;
  return planId === 'byteplus-coding-plan-team-pro' ? 'Pro' : 'Lite';
}
