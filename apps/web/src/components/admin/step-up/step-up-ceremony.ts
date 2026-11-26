import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

export type StepUpOptions =
  | { ok: true; challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }
  | { ok: false; code?: string };

export type StepUpCeremonyDeps = {
  requestOptions: () => Promise<StepUpOptions>;
  startAuthentication: (options: PublicKeyCredentialRequestOptionsJSON) => Promise<unknown>;
  submitAssertion: (challengeId: string, response: unknown) => Promise<boolean>;
};

export type StepUpCeremonyResult = { ok: true } | { ok: false; code?: string };

/**
 * One step-up attempt: mint options, run the browser's passkey sheet, submit the
 * assertion. An account with no passkey answers `NOT_ENROLLED`; the caller
 * enrolls one, which needs a code from the person's email. Cancelling the sheet
 * is a terminal result, not a retry.
 */
export async function runStepUpCeremony(deps: StepUpCeremonyDeps): Promise<StepUpCeremonyResult> {
  const options = await deps.requestOptions();
  if (!options.ok) return { ok: false, code: options.code };

  let assertion: unknown;
  try {
    assertion = await deps.startAuthentication(options.options);
  } catch (error) {
    // @simplewebauthn/browser throws NotAllowedError when the user dismisses
    // the sheet and AbortError on a timeout. Anything else is a real browser
    // or authenticator failure and must not read as a deliberate cancel.
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError' || name === 'AbortError') {
      return { ok: false, code: 'CANCELLED' };
    }
    return { ok: false, code: 'VERIFICATION_FAILED' };
  }

  return (await deps.submitAssertion(options.challengeId, assertion))
    ? { ok: true }
    : { ok: false };
}
