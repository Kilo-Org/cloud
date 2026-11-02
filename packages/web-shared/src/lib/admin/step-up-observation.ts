import 'server-only';
import { captureException } from '@sentry/nextjs';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type {
  AdminStepUpState,
  PrivilegedActionClass,
  PrivilegedCredentialKind,
} from '@kilocode/web-shared/lib/admin/privileged-access';
import type { AdminStepUpMode } from '@kilocode/web-shared/lib/config.server';

export type StepUpObservation = {
  surface: 'rest' | 'trpc' | 'server-component';
  kiloUserId: string;
  credential: PrivilegedCredentialKind;
  actionClass: PrivilegedActionClass;
  state: AdminStepUpState;
  mode: AdminStepUpMode;
  route: string | null;
  method: string | null;
  /** True when the measurement itself failed and was treated as absent. */
  errored?: boolean;
};

/**
 * Observe-only step-up telemetry. Records the state and whether enforcement
 * would have blocked; never includes a session id, its hash, a challenge, or a
 * passkey assertion.
 */
export function emitStepUpObservation(observation: StepUpObservation): void {
  logExceptInTest(
    JSON.stringify({
      event: 'admin_step_up_evaluation',
      surface: observation.surface,
      kiloUserId: observation.kiloUserId,
      credential: observation.credential,
      actionClass: observation.actionClass,
      stepUpStatus: observation.state.status,
      mode: observation.mode,
      wouldBlock: observation.state.status !== 'fresh',
      route: observation.route,
      method: observation.method,
      ...(observation.errored ? { errored: true } : {}),
    })
  );
}

/**
 * Report a step-up infrastructure failure without the original error. Drizzle
 * errors embed statement parameters, which can include session hashes and
 * challenges; only the error shape is safe to send.
 */
export function reportStepUpFailure(source: string, error: unknown): void {
  captureException(new Error('step_up_failure'), {
    tags: { source },
    extra: { errorName: error instanceof Error ? error.name : typeof error },
  });
}
