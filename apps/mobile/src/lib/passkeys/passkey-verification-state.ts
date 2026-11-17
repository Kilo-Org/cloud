import { type PasskeyManagementOperation } from '@/lib/auth/passkey-management';

/** The proof the panel is waiting on, as one union with one member per phase. */
export type PasskeyVerificationState =
  | { phase: 'closed' }
  /**
   * The panel offers the proofs that can work for this account: a passkey when
   * the account has one, and an emailed code always. `notice` explains why the
   * previous proof was refused; a terminal refusal replaces the panel instead.
   */
  | {
      phase: 'choose';
      operation: PasskeyManagementOperation;
      notice: string | null;
      passkeyOffered: boolean;
    }
  /** The code request is in flight. */
  | { phase: 'sending-code'; operation: PasskeyManagementOperation }
  /** The platform's passkey sheet is up. */
  | { phase: 'asserting'; operation: PasskeyManagementOperation }
  /** The SSO approval request is being bound to this session. */
  | { phase: 'sso-starting'; operation: PasskeyManagementOperation }
  /**
   * The person approves in the OS browser with their SSO session. `error` is a
   * catalog key when the request expired, was cancelled or could not be
   * collected; `waiting` covers the start and poll requests in flight.
   */
  | {
      phase: 'sso-approval';
      operation: PasskeyManagementOperation;
      approvalUrl: string;
      error: string | null;
      waiting: boolean;
    }
  /** The proof is accepted and the authorization is being minted. */
  | { phase: 'authorizing'; operation: PasskeyManagementOperation }
  | {
      phase: 'enter-code';
      operation: PasskeyManagementOperation;
      email: string;
      challengeId: string;
      error: string | null;
      retrying: boolean;
    }
  /** Nothing this person can do from this app fixes the refusal. */
  | { phase: 'blocked'; operation: PasskeyManagementOperation; message: string };

/** The panel's state and the actions each phase offers. */
export type PasskeyVerification = {
  state: PasskeyVerificationState;
  /** Start verifying for one operation; the authorization reaches `onAuthorized`. */
  open: (
    operation: PasskeyManagementOperation,
    onAuthorized: (authorization: string) => void,
    notice?: string
  ) => void;
  handleChoosePasskey: () => void;
  handleChooseEmail: () => void;
  /** Start the SSO browser approval; also what an SSO refusal falls into. */
  handleChooseSso: () => void;
  /** Re-open the approval page for the pending request. */
  handleReopenApproval: () => void;
  handleSubmitCode: (code: string) => void;
  handleResendCode: () => void;
  handleCancel: () => void;
};
