import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { StepUpCancelledError, type StepUpRequirement } from './step-up-error';

export type StepUpOptions =
  | { ok: true; challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }
  | { ok: false; code?: string };

export type StepUpCeremonyDeps = {
  requestOptions: () => Promise<StepUpOptions>;
  startAuthentication: (options: PublicKeyCredentialRequestOptionsJSON) => Promise<unknown>;
  submitAssertion: (challengeId: string, response: unknown) => Promise<boolean>;
  enroll: () => Promise<void>;
};

export type StepUpCeremonyResult = { ok: true } | { ok: false; code?: string };

/**
 * One step-up attempt: mint options, run the browser's passkey sheet, submit the
 * assertion. When the account has no passkey the ceremony enrolls one first and
 * mints options again exactly once. Cancelling the sheet is a terminal result,
 * not a retry.
 */
export async function runStepUpCeremony(deps: StepUpCeremonyDeps): Promise<StepUpCeremonyResult> {
  let options = await deps.requestOptions();
  if (!options.ok && options.code === 'NOT_ENROLLED') {
    await deps.enroll();
    options = await deps.requestOptions();
  }
  if (!options.ok) return { ok: false, code: options.code };

  let assertion: unknown;
  try {
    assertion = await deps.startAuthentication(options.options);
  } catch {
    return { ok: false, code: 'CANCELLED' };
  }

  return (await deps.submitAssertion(options.challengeId, assertion))
    ? { ok: true }
    : { ok: false };
}

/**
 * Run one operation, and if it refuses with a step-up requirement, verify and
 * retry that operation exactly once. A second refusal is returned to the
 * caller. A cancelled verification rejects without retrying.
 */
export async function runWithStepUp<T>(
  operation: () => Promise<T>,
  requestStepUp: (requirement: StepUpRequirement) => Promise<boolean>,
  requirementFromError: (error: unknown) => StepUpRequirement | null
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const requirement = requirementFromError(error);
    if (!requirement) throw error;
    const verified = await requestStepUp(requirement);
    if (!verified) throw new StepUpCancelledError();
    return await operation();
  }
}
