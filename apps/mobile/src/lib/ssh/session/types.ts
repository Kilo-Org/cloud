import { type SshErrorCode } from '../../../../modules/kilo-ssh/src';

/**
 * Why a session stopped. `SshErrorCode` names what the Rust core reports; the
 * rest are this app's own endings. `InvalidExport` is excluded: it belongs to
 * the encrypted export, so no connection can ever end with it.
 */
export type SshCloseReason =
  | Exclude<SshErrorCode, 'InvalidExport'>
  | 'disconnected'
  | 'user'
  | 'key-missing'
  | 'host-missing'
  | 'unavailable';

/**
 * The endings a new attempt can clear without changing anything the person
 * entered: the transport failed, not the credentials or the host key.
 */
const RETRYABLE_REASONS = [
  'Network',
  'Timeout',
  'ChannelClosed',
  'disconnected',
] as const satisfies readonly SshCloseReason[];

export function isRetryableReason(reason: SshCloseReason): boolean {
  return RETRYABLE_REASONS.some(candidate => candidate === reason);
}

/** A host key the connection is waiting on the person to decide about. */
export type SshHostKeyAwaiting = {
  readonly requestId: string;
  /** The OpenSSH pattern the decision is stored under. */
  readonly hostPattern: string;
  readonly algorithm: string;
  readonly publicKeyBase64: string;
  readonly fingerprintSha256: string;
  /** What the store already trusts for this host and algorithm, on a mismatch. */
  readonly knownFingerprintSha256: string | null;
};

type SshPrompt = {
  readonly text: string;
  /** Whether the answer may be displayed as it is typed. */
  readonly echo: boolean;
};

/** A keyboard-interactive round the server is waiting on. */
export type SshPromptsAwaiting = {
  readonly requestId: string;
  readonly name: string;
  readonly instructions: string;
  readonly prompts: readonly SshPrompt[];
};

export type SshSessionPhase =
  | { readonly kind: 'connecting'; readonly attempt: number }
  | { readonly kind: 'awaiting-host-key'; readonly hostKey: SshHostKeyAwaiting }
  | {
      readonly kind: 'awaiting-password';
      readonly failed: boolean;
      /** The hop that needs it, when the target is reached through a jump host. */
      readonly label: string | null;
    }
  | { readonly kind: 'awaiting-passphrase'; readonly failed: boolean }
  | { readonly kind: 'awaiting-prompts'; readonly prompts: SshPromptsAwaiting }
  | { readonly kind: 'connected' }
  | { readonly kind: 'reconnecting'; readonly attempt: number; readonly reason: SshCloseReason }
  | { readonly kind: 'closed'; readonly reason: SshCloseReason; readonly retryable: boolean };

export type SshSession = {
  readonly id: string;
  readonly hostId: string;
  readonly label: string;
  /** `user@host:port`, as the hosts list shows it. */
  readonly target: string;
  readonly startedAt: number;
  readonly phase: SshSessionPhase;
  /** The native terminal source to render while a shell is open. */
  readonly shellId: string | null;
  /**
   * The connection an SFTP channel or a port forward attaches to. Null until
   * the chain of hops reached the target, and again when it drops.
   */
  readonly nativeSessionId: string | null;
  /** A command the terminal types once its view mounts: the tmux attach. */
  readonly pendingCommand: string | null;
};

/** The decisions the host-key sheet offers. */
export type SshHostKeyDecision = 'once' | 'save' | 'cancel';

/**
 * Whether the session is waiting on an answer the prompt sheet asks for. A
 * changed host key is excluded: nothing is asked there, because the sheet has
 * no Accept — that state is the blocked screen.
 */
export function needsPrompt(phase: SshSessionPhase): boolean {
  switch (phase.kind) {
    case 'awaiting-host-key': {
      return phase.hostKey.knownFingerprintSha256 === null;
    }
    case 'awaiting-password':
    case 'awaiting-passphrase':
    case 'awaiting-prompts': {
      return true;
    }
    case 'connected':
    case 'connecting':
    case 'reconnecting':
    case 'closed': {
      return false;
    }
    default: {
      return false;
    }
  }
}
