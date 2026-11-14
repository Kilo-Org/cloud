/**
 * Why the Add control on the passkeys screen did not add a row, and which
 * notice the screen shows for it.
 *
 * A ceremony that failed has no half-written credential to clean up, so the
 * same control is a working retry. An `unsupported` result removes the control
 * instead, because a device that has just refused the ceremony cannot create
 * one, and so does `unavailable`, because the account cannot add a passkey from
 * this app; repeating either request cannot change the answer.
 */
export type AddFailure = 'unsupported' | 'unavailable' | 'failed';

/** The catalog keys the screen can show in place of, or beside, the control. */
export type AddFailureNoticeKey =
  | 'profile.passkeyAddUnavailable'
  | 'profile.passkeyAddUnsupported'
  | 'profile.passkeyAddFailed';

/**
 * The notice that explains why the Add control will not add a row, or `null`
 * when there is nothing to explain: the control is offered and the last attempt
 * was not a failure.
 *
 * Two cases read the same failure differently. While the control is offered,
 * only a failed attempt is worth reporting. Once it is withdrawn, the reason it
 * is gone takes the hint's place, so a null failure means the device itself
 * cannot create passkeys.
 */
export function addFailureNoticeKey(
  canCreate: boolean,
  failure: AddFailure | null
): AddFailureNoticeKey | null {
  if (!canCreate) {
    return failure === 'unavailable'
      ? 'profile.passkeyAddUnavailable'
      : 'profile.passkeyAddUnsupported';
  }
  return failure === 'failed' ? 'profile.passkeyAddFailed' : null;
}
