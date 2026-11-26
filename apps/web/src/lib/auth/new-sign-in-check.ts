import 'server-only';
import { captureException } from '@sentry/nextjs';
import { runAfterResponse } from '@/lib/after-response';
import { networkKey, recordSignInContext, type SignInDevice } from '@/lib/auth/sign-in-context';
import { scheduleSecurityNotice, securityNoticeRequestFromHeaders } from '@/lib/security-notices';

/**
 * Checks one completed sign-in for a new device on a new network, after the
 * response, and schedules the new-sign-in notice when it is one.
 *
 * The request values are read now, while the request is in scope; the
 * database work runs after the response, so it adds nothing to the sign-in's
 * latency. A failure never reaches the sign-in. It is reported as a fixed
 * error: a database error's message carries the query parameters (the user
 * id and the digests). A check skipped at its lock limit (`lock_busy`) is no
 * failure and is not reported; it writes one log line that names only the
 * outcome, so skips stay countable.
 */
export async function scheduleNewSignInCheck(params: {
  user: { id: string; google_user_email: string };
  method: string;
  device: SignInDevice;
  headers: Headers;
}): Promise<void> {
  const { user, method, device, headers } = params;
  const request = securityNoticeRequestFromHeaders(headers);
  const network = networkKey(headers);

  await runAfterResponse(async () => {
    try {
      const decision = await recordSignInContext({
        userId: user.id,
        device,
        network,
        now: request.occurredAt,
      });
      if (decision.kind === 'lock_busy') {
        console.log(JSON.stringify({ source: 'sign_in_context_check', outcome: 'lock_busy' }));
        return;
      }
      if (decision.kind !== 'new_device_new_network') return;
      await scheduleSecurityNotice(user, { type: 'new_sign_in', method }, request);
    } catch {
      captureException(new Error('sign_in_context_check_failed'), {
        tags: { source: 'sign_in_context_check' },
      });
    }
  });
}
