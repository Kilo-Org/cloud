import type { RuntimeAuthorizationBindingRejectionReason } from '@kilocode/worker-utils/runtime-authorization';
import { logger } from '../logger.js';

export type RecoveryDenialReason =
  | 'metadata_unavailable'
  | 'owner_mismatch'
  | 'missing_secret'
  | 'invalid_seal'
  | 'fresh_authorization_inactive'
  | 'kilo_session_missing'
  | 'authorization_state_changed';

type DiagnosticReason =
  | RuntimeAuthorizationBindingRejectionReason
  | RecoveryDenialReason
  | 'stored_authorization_invalid'
  | 'stored_authorization_revoked'
  | 'delegation_expired'
  | 'post_renewal_state_changed'
  | 'renewal_revoked'
  | 'renewal_failed'
  | 'revocation_persisted'
  | 'recovery_denied';

export function logRuntimeAuthorizationDiagnostic(
  sessionId: string | undefined,
  stage: 'preflight' | 'recovery_state' | 'renewal' | 'binding_check' | 'recovery',
  reason: DiagnosticReason
): void {
  try {
    const diagnostic = logger.withFields({ ...(sessionId ? { sessionId } : {}), stage, reason });
    if (stage === 'recovery' && reason === 'missing_secret') {
      diagnostic.error('Runtime authorization recovery denied');
    } else {
      diagnostic.warn('Runtime authorization diagnostic');
    }
  } catch {
    // Logging must not change authorization decisions or public errors.
  }
}

export function runtimeAuthorizationRecoveryDenied(
  sessionId: string | undefined,
  reason: RecoveryDenialReason
): { status: 'denied' } {
  logRuntimeAuthorizationDiagnostic(sessionId, 'recovery', reason);
  return { status: 'denied' };
}
