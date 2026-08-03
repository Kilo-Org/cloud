import 'server-only';
import { type db } from '@/lib/drizzle';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import { isEligibleForVercelUserByok } from '@/lib/ai-gateway/models';
import {
  getModelUserByokProviders,
  getOrganizationByokProviderIds,
  getUserByokProviderIds,
} from '@/lib/ai-gateway/byok';
import type { User } from '@kilocode/db/schema';

export type BalanceCheckModelEligibility = {
  isFree: boolean;
  hasUserByokAvailable: boolean;
};

/**
 * Decide whether `prepareSession` should skip the worker-side $1 balance
 * minimum for the chosen model.
 *
 * Skips the check when either:
 * - the model is Kilo-funded (free for the user), or
 * - the model is eligible for Vercel user BYOK AND the user has a provider
 *   configured that can serve it, so the session is billed against the
 *   user's own key rather than their balance.
 *
 * Kilo-exclusive models are eligible only when their gateway is Vercel or
 * they explicitly allow Vercel routing. Other exclusives remain platform
 * billed and must go through the worker-side balance check.
 */
export async function computeCloudAgentNextBalanceCheckEligibility(params: {
  fromDb: typeof db;
  user: Pick<User, 'id'>;
  modelId: string;
  organizationId?: string;
}): Promise<BalanceCheckModelEligibility> {
  const isFree = await isFreeModel(params.modelId);
  if (isFree) {
    return { isFree: true, hasUserByokAvailable: false };
  }

  if (!isEligibleForVercelUserByok(params.modelId)) {
    return { isFree: false, hasUserByokAvailable: false };
  }

  const modelProviders = await getModelUserByokProviders(params.modelId);
  if (modelProviders.length === 0) {
    return { isFree: false, hasUserByokAvailable: false };
  }

  const enabledProviderIds = params.organizationId
    ? await getOrganizationByokProviderIds(params.fromDb, params.organizationId)
    : await getUserByokProviderIds(params.fromDb, params.user.id);

  const enabled = new Set(enabledProviderIds);
  const hasUserByokAvailable = modelProviders.some(provider => enabled.has(provider));
  return { isFree: false, hasUserByokAvailable };
}
