'use client';

import {
  stepUpRequirementFromResponse,
  type StepUpRequirement,
} from '@/components/admin/step-up/step-up-error';
import { verifyStepUpWithHandler } from '@/lib/trpc/step-up-link';

export class AdminStepUpCancelledError extends Error {
  readonly data: { stepUp: StepUpRequirement };

  constructor(requirement: StepUpRequirement) {
    super('Step-up cancelled');
    this.name = 'AdminStepUpCancelledError';
    this.data = { stepUp: requirement };
  }
}

/**
 * `fetch` for admin REST calls. A 403 carrying a step-up code opens the same
 * verification dialog as tRPC and retries the request exactly once. Bearer
 * refusals and non-step-up errors are returned unchanged.
 */
export async function adminFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  const requirement: StepUpRequirement | null = await stepUpRequirementFromResponse(response);
  if (!requirement || requirement.code === 'BEARER_NOT_ALLOWED') return response;

  const verified = await verifyStepUpWithHandler(requirement);
  if (!verified) {
    // Carry the requirement on the thrown error so React Query's retry
    // predicate can suppress an automatic retry after the user cancels.
    throw new AdminStepUpCancelledError(requirement);
  }
  return fetch(input, init);
}
