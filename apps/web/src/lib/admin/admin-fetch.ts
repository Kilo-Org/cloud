'use client';

import {
  stepUpRequirementFromResponse,
  type StepUpRequirement,
} from '@/components/admin/step-up/step-up-error';
import { verifyStepUpWithHandler } from '@/lib/trpc/step-up-link';

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
  if (!verified) return response;
  return fetch(input, init);
}
