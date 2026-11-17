/* eslint-disable max-lines -- one hook owns the verification attempt, its single-flight guard, the stale-answer rules and all three proof flows; splitting it would let a second module hold half of that invariant */
import { useEffect, useRef, useState } from 'react';

import {
  type AuthBrowserKind,
  dismissAuthBrowser,
  openAuthBrowser,
  resolveAuthBrowserKind,
} from '@/lib/auth/auth-browser';
import { mintPasskeyTicket } from '@/lib/auth/passkey-client';
import {
  authorizePasskeyManagementWithCode,
  authorizePasskeyManagementWithTicket,
  collectPasskeyManagementSso,
  type ManagementProofFailure,
  type PasskeyManagementOperation,
  requestManagementCode,
  type SsoApprovalFailure,
  startPasskeyManagementSso,
} from '@/lib/auth/passkey-management';
import {
  type PasskeyVerification,
  type PasskeyVerificationState,
} from '@/lib/passkeys/passkey-verification-state';

/** The catalog key that explains each refusal, in the active language. */
const FAILURE_KEYS = {
  'device-unsupported': 'profile.passkeyManagementUnavailable',
  'invalid-code': 'profile.passkeyVerifyCodeRejected',
  'invalid-ticket': 'profile.passkeyVerifyPasskeyFailed',
  'in-progress': 'profile.passkeyVerifyInProgress',
  'too-many-attempts': 'profile.passkeyVerifyTooManyAttempts',
  'sso-required': 'profile.passkeyVerifySsoRequired',
  'session-ended': 'login.sessionEnded',
  'admission-required': 'profile.passkeyVerifyAdmissionRequired',
  retryable: 'profile.passkeyVerifyFailed',
  failed: 'profile.passkeyVerifyFailed',
} satisfies Record<ManagementProofFailure, string>;

/** Why a proof is terminal for the email path on an SSO-only account. */
const PASSKEY_UNAVAILABLE_KEY = 'profile.passkeyVerifyPasskeyUnavailable';

/** How often the app asks whether the browser leg approved. */
const SSO_POLL_INTERVAL_MS = 3000;

/** The catalog key that explains each SSO refusal. */
const SSO_FAILURE_KEYS = {
  expired: 'profile.passkeyVerifySsoExpired',
  'sso-not-required': 'profile.passkeyVerifySsoUnavailable',
  'device-unsupported': 'profile.passkeyManagementUnavailable',
  'session-ended': 'login.sessionEnded',
  'admission-required': 'profile.passkeyVerifyAdmissionRequired',
  blocked: 'profile.passkeyVerifySsoUnavailable',
  'sso-unavailable': 'profile.passkeyVerifySsoUnavailable',
  retryable: 'profile.passkeyVerifySsoUnavailable',
} satisfies Record<SsoApprovalFailure, string>;

/**
 * One verification attempt. It owns everything the attempt needs — the account
 * it started for, the operation it will authorize, the code challenge, and
 * whether a step is pending — so there is no second ref to keep in step, and a
 * cancellation or an account switch drops exactly one object.
 */
type ActiveAttempt = {
  accountId: string | undefined;
  operation: PasskeyManagementOperation;
  email: string | undefined;
  challengeId: string | undefined;
  stepPending: boolean;
  /** The approval page this attempt opened, when it opened one. */
  browser: AuthBrowserKind | null;
  onAuthorized: (authorization: string) => void;
};

/**
 * Fresh primary verification for passkey management, in the app.
 *
 * Every native management call carries a management authorization minted from
 * a live primary proof: a passkey assertion, or a code sent to the account's own
 * address. This hook owns that proof's phases, its single-flight guard and the
 * rules that keep a late answer from landing on a different attempt:
 *
 * - One attempt at a time. An attempt starts a step only while it has none
 *   pending, so a second tap starts nothing.
 * - Every completion is checked against the attempt object it belongs to. A
 *   cancelled, finished or superseded attempt is no longer the active one, so
 *   its answers are inert. An account switch cancels the active attempt.
 * - The authorization is handed over once, to the operation that asked for it,
 *   and only while its originating account is still signed in. It is single-use
 *   by design, so it is never cached across operations.
 */
export function usePasskeyVerification(options: {
  accountId: string | undefined;
  email: string | undefined;
  hasPasskey: boolean;
}): PasskeyVerification {
  const [state, setState] = useState<PasskeyVerificationState>({ phase: 'closed' });
  const activeRef = useRef<ActiveAttempt | null>(null);
  const ssoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const accountIdRef = useRef(options.accountId);
  const emailRef = useRef(options.email);
  const hasPasskeyRef = useRef(options.hasPasskey);
  accountIdRef.current = options.accountId;
  emailRef.current = options.email;
  hasPasskeyRef.current = options.hasPasskey;

  /** True only for the attempt that is still the active one. */
  const isCurrent = (attempt: ActiveAttempt) => activeRef.current === attempt;

  const stopSsoPoll = () => {
    if (ssoTimerRef.current !== null) {
      clearTimeout(ssoTimerRef.current);
      ssoTimerRef.current = null;
    }
  };

  /**
   * Close the approval page this attempt opened, with the API that opened it
   * (`dismissAuthBrowser` does nothing to the other one). The attempt owns the
   * page, so a late answer from a finished or cancelled attempt has nothing to
   * close, and the page a newer attempt opened stays where it is.
   */
  const closeAttemptBrowser = (attempt: ActiveAttempt) => {
    const kind = attempt.browser;
    attempt.browser = null;
    if (kind !== null) {
      dismissAuthBrowser(kind);
    }
  };

  const cancel = () => {
    const attempt = activeRef.current;
    if (attempt) {
      closeAttemptBrowser(attempt);
    }
    stopSsoPoll();
    activeRef.current = null;
    setState({ phase: 'closed' });
  };

  // An account switch makes the active attempt belong to someone else. A
  // first resolution of the identity (undefined → an id) is adopted by the
  // attempt instead, because that is the same person becoming known.
  const accountId = options.accountId;
  useEffect(() => {
    const attempt = activeRef.current;
    if (!attempt) {
      return;
    }
    if (attempt.accountId === undefined || attempt.accountId === accountId) {
      attempt.accountId = accountId;
      return;
    }
    stopSsoPoll();
    closeAttemptBrowser(attempt);
    activeRef.current = null;
    setState({ phase: 'closed' });
  }, [accountId]);

  // Unmounting ends the attempt with the screen that asked for it.
  useEffect(
    () => () => {
      const attempt = activeRef.current;
      if (attempt) {
        closeAttemptBrowser(attempt);
      }
      if (ssoTimerRef.current !== null) {
        clearTimeout(ssoTimerRef.current);
        ssoTimerRef.current = null;
      }
      activeRef.current = null;
    },
    []
  );

  const open = (
    operation: PasskeyManagementOperation,
    onAuthorized: (authorization: string) => void,
    notice?: string
  ) => {
    if (activeRef.current) {
      return;
    }
    activeRef.current = {
      accountId: accountIdRef.current,
      operation,
      email: emailRef.current,
      challengeId: undefined,
      stepPending: false,
      browser: null,
      onAuthorized,
    };
    setState({
      phase: 'choose',
      operation,
      notice: notice ?? null,
      passkeyOffered: hasPasskeyRef.current,
    });
  };

  /** One step of the active attempt at a time; a second tap starts nothing. */
  const beginStep = () => {
    const attempt = activeRef.current;
    if (!attempt || attempt.stepPending) {
      return null;
    }
    attempt.stepPending = true;
    return attempt;
  };

  const endStep = (attempt: ActiveAttempt) => {
    attempt.stepPending = false;
  };

  const finish = (attempt: ActiveAttempt, authorization: string) => {
    // The proof belongs to the account that started it: an attempt superseded
    // by a sign-out, a sign-in or a newer attempt never authorizes anything.
    if (!isCurrent(attempt)) {
      return;
    }
    // The identity resolved after this attempt opened; it is the same person
    // becoming known, so the attempt adopts it.
    attempt.accountId ??= accountIdRef.current;
    if (attempt.accountId !== accountIdRef.current) {
      closeAttemptBrowser(attempt);
      activeRef.current = null;
      setState({ phase: 'closed' });
      return;
    }
    // The approval page has done its job: close it before the native
    // operation, so it cannot sit over the sheet that operation presents.
    closeAttemptBrowser(attempt);
    activeRef.current = null;
    stopSsoPoll();
    setState({ phase: 'closed' });
    attempt.onAuthorized(authorization);
  };

  /** Back to the proof choices, naming why the last one did not work. */
  const refuse = (
    attempt: ActiveAttempt,
    failure: ManagementProofFailure,
    passkeyOffered: boolean
  ) => {
    if (failure === 'device-unsupported' || failure === 'session-ended') {
      setState({
        phase: 'blocked',
        operation: attempt.operation,
        message: FAILURE_KEYS[failure],
      });
      return;
    }
    setState({
      phase: 'choose',
      operation: attempt.operation,
      notice: FAILURE_KEYS[failure],
      passkeyOffered,
    });
  };

  /** A rejected boundary is a retryable refusal, never an unhandled rejection. */
  const refuseRejection = (attempt: ActiveAttempt) => {
    if (isCurrent(attempt)) {
      refuse(attempt, 'retryable', hasPasskeyRef.current);
    }
  };

  const choosePasskey = () => {
    const attempt = beginStep();
    if (!attempt) {
      return;
    }
    setState({ phase: 'asserting', operation: attempt.operation });
    void (async () => {
      try {
        const minted = await mintPasskeyTicket();
        if (!isCurrent(attempt)) {
          return;
        }
        if (minted.status === 'error') {
          // A dismissed sheet changed nothing, so the panel returns to its
          // choices without an error. A passkey this device cannot present
          // withdraws the offer; anything else is a retryable refusal.
          if (minted.failure === 'cancelled') {
            setState({
              phase: 'choose',
              operation: attempt.operation,
              notice: null,
              passkeyOffered: true,
            });
          } else if (minted.failure === 'unsupported' || minted.failure === 'no-passkey') {
            setState({
              phase: 'choose',
              operation: attempt.operation,
              notice: PASSKEY_UNAVAILABLE_KEY,
              passkeyOffered: false,
            });
          } else {
            refuse(attempt, 'invalid-ticket', true);
          }
          return;
        }
        setState({ phase: 'authorizing', operation: attempt.operation });
        const result = await authorizePasskeyManagementWithTicket({
          operation: attempt.operation,
          ticket: minted.ticket,
        });
        if (!isCurrent(attempt)) {
          return;
        }
        if (result.status === 'authorized') {
          finish(attempt, result.authorization);
          return;
        }
        // A passkey assertion is refused for an SSO-enforced domain, which is
        // the same answer the email step gives: the browser approval is the
        // proof that domain accepts.
        if (result.failure === 'sso-required') {
          setTimeout(() => {
            if (isCurrent(attempt)) {
              chooseSso();
            }
          }, 0);
          return;
        }
        refuse(attempt, result.failure, result.failure !== 'invalid-ticket');
      } catch {
        refuseRejection(attempt);
      } finally {
        endStep(attempt);
      }
    })();
  };

  const chooseEmail = () => {
    const attempt = beginStep();
    if (!attempt) {
      return;
    }
    setState({ phase: 'sending-code', operation: attempt.operation });
    void (async () => {
      try {
        const email = attempt.email;
        if (!email) {
          refuse(attempt, 'retryable', hasPasskeyRef.current);
          return;
        }
        const result = await requestManagementCode(email);
        if (!isCurrent(attempt)) {
          return;
        }
        if (result.status === 'sent') {
          attempt.challengeId = result.challengeId;
          setState({
            phase: 'enter-code',
            operation: attempt.operation,
            email,
            challengeId: result.challengeId,
            error: null,
            retrying: false,
          });
          return;
        }
        if (result.failure === 'sso-required') {
          // The account's domain accepts no emailed code, so the browser SSO
          // approval is the only primary factor it can give. Start it once this
          // step releases, so its own single-flight guard admits it.
          setTimeout(() => {
            if (isCurrent(attempt)) {
              chooseSso();
            }
          }, 0);
          return;
        }
        refuse(attempt, result.failure, hasPasskeyRef.current);
      } catch {
        refuseRejection(attempt);
      } finally {
        endStep(attempt);
      }
    })();
  };

  /** A refused or lost approval stays in the panel, with a working retry. */
  const showSsoError = (
    attempt: ActiveAttempt,
    failure: SsoApprovalFailure,
    approvalUrl: string
  ) => {
    if (!isCurrent(attempt)) {
      return;
    }
    setState({
      phase: 'sso-approval',
      operation: attempt.operation,
      approvalUrl,
      error: SSO_FAILURE_KEYS[failure],
      waiting: false,
    });
  };

  /**
   * Ask the server whether the browser leg approved, until the request's own
   * window ends. Every answer is checked against the attempt, so cancelling or
   * an account switch ends the loop without a stale operation.
   */
  const pollSsoApproval = (
    attempt: ActiveAttempt,
    request: { requestId: string; approvalUrl: string; expiresAtMs: number }
  ) => {
    const { requestId, approvalUrl, expiresAtMs } = request;
    const tick = async () => {
      ssoTimerRef.current = null;
      if (!isCurrent(attempt)) {
        return;
      }
      try {
        if (Date.now() >= expiresAtMs) {
          showSsoError(attempt, 'expired', approvalUrl);
          return;
        }
        const collected = await collectPasskeyManagementSso({ requestId });
        if (!isCurrent(attempt)) {
          return;
        }
        if (collected.status === 'authorized') {
          finish(attempt, collected.authorization);
          return;
        }
        if (collected.status === 'pending') {
          ssoTimerRef.current = setTimeout(() => {
            void tick();
          }, SSO_POLL_INTERVAL_MS);
          return;
        }
        showSsoError(attempt, collected.failure, approvalUrl);
      } catch {
        // A rejected poll wrote nothing: the panel names the refusal and its
        // retry starts a new request, so no rejection stays unhandled.
        showSsoError(attempt, 'retryable', approvalUrl);
      }
    };
    ssoTimerRef.current = setTimeout(() => {
      void tick();
    }, 0);
  };

  const chooseSso = () => {
    const attempt = beginStep();
    if (!attempt) {
      return;
    }
    // A new request supersedes the one before it: exactly one poll runs, and
    // the abandoned request can only expire on the server. Its page is closed
    // first, because one presented page cannot be replaced by another.
    stopSsoPoll();
    closeAttemptBrowser(attempt);
    setState({ phase: 'sso-starting', operation: attempt.operation });
    void (async () => {
      try {
        const started = await startPasskeyManagementSso({ operation: attempt.operation });
        if (!isCurrent(attempt)) {
          return;
        }
        if (started.status === 'error') {
          // The domain may not actually require SSO: then a native proof is the
          // right path, and the panel says the attempt can be repeated. A
          // reported admission failure already showed its own message.
          if (started.failure === 'sso-not-required' || started.failure === 'reported') {
            refuse(attempt, 'retryable', hasPasskeyRef.current);
            return;
          }
          showSsoError(attempt, started.failure, '');
          return;
        }
        setState({
          phase: 'sso-approval',
          operation: attempt.operation,
          approvalUrl: started.approvalUrl,
          error: null,
          waiting: true,
        });
        pollSsoApproval(attempt, {
          requestId: started.requestId,
          approvalUrl: started.approvalUrl,
          expiresAtMs: started.expiresAtMs,
        });
        // The attempt owns the page it presents: recording the kind before the
        // call means a cancellation that lands mid-open still closes it.
        attempt.browser = resolveAuthBrowserKind(started.approvalUrl);
        // The page may refuse to present. The request keeps its window and the
        // panel's own "Open the approval page" is the retry, so the rejection
        // is shown there instead of staying unhandled. The open is not awaited
        // in this step: on iOS it settles when the page is dismissed, and the
        // step must stay free for the panel's own controls.
        void (async () => {
          try {
            await openAuthBrowser(started.approvalUrl);
          } catch {
            showSsoError(attempt, 'retryable', started.approvalUrl);
          }
        })();
      } catch {
        if (isCurrent(attempt)) {
          refuse(attempt, 'retryable', hasPasskeyRef.current);
        }
      } finally {
        endStep(attempt);
      }
    })();
  };

  const reopenApproval = () => {
    if (state.phase !== 'sso-approval' || state.approvalUrl === '') {
      return;
    }
    const approvalUrl = state.approvalUrl;
    const attempt = activeRef.current;
    if (attempt) {
      attempt.browser = resolveAuthBrowserKind(approvalUrl);
    }
    // A page that still refuses to present is stated where the button is, and
    // the button that was pressed is the retry.
    void (async () => {
      try {
        await openAuthBrowser(approvalUrl);
      } catch {
        if (attempt) {
          showSsoError(attempt, 'retryable', approvalUrl);
        }
      }
    })();
  };

  const submitCode = (code: string) => {
    const active = activeRef.current;
    if (active?.challengeId === undefined || code.trim().length === 0) {
      return;
    }
    const attempt = beginStep();
    if (!attempt) {
      return;
    }
    const challengeId = active.challengeId;
    const email = attempt.email;
    setState(current =>
      current.phase === 'enter-code' ? { ...current, error: null, retrying: true } : current
    );
    void (async () => {
      try {
        if (!email) {
          refuse(attempt, 'retryable', hasPasskeyRef.current);
          return;
        }
        const result = await authorizePasskeyManagementWithCode({
          operation: attempt.operation,
          email,
          code: code.trim(),
          challengeId,
        });
        if (!isCurrent(attempt)) {
          return;
        }
        if (result.status === 'authorized') {
          finish(attempt, result.authorization);
          return;
        }
        if (result.failure === 'device-unsupported' || result.failure === 'session-ended') {
          refuse(attempt, result.failure, hasPasskeyRef.current);
          return;
        }
        // The challenge survives a refused code: a mistyped digit, a shared
        // attempt budget, or a reservation another request still holds are
        // all fixed in this field. The message says which.
        setState(current =>
          current.phase === 'enter-code'
            ? {
                ...current,
                error: result.reported ? null : FAILURE_KEYS[result.failure],
                retrying: false,
              }
            : current
        );
      } catch {
        // A rejected boundary — the request-token or admission read behind the
        // mint — wrote nothing; the same field is a working retry.
        if (isCurrent(attempt)) {
          setState(current =>
            current.phase === 'enter-code'
              ? { ...current, error: FAILURE_KEYS.retryable, retrying: false }
              : current
          );
        }
      } finally {
        endStep(attempt);
      }
    })();
  };

  return {
    state,
    open,
    handleChoosePasskey: choosePasskey,
    handleChooseEmail: chooseEmail,
    handleChooseSso: chooseSso,
    handleReopenApproval: reopenApproval,
    handleSubmitCode: submitCode,
    handleResendCode: chooseEmail,
    handleCancel: cancel,
  };
}
