import 'server-only';
import { captureException } from '@sentry/nextjs';
import { runAfterResponse } from '@/lib/after-response';
import {
  hashSignInDevice,
  hashSignInKey,
  networkKey,
  recordSignInContext,
  type SignInDevice,
} from '@/lib/auth/sign-in-context';
import { scheduleSecurityNotice, securityNoticeRequestFromHeaders } from '@/lib/security-notices';

/**
 * Checks one completed sign-in for a new device on a new network, after the
 * response, and schedules the new-sign-in notice when it is one.
 *
 * The request values are read now, while the request is in scope; the
 * database work runs after the response, so it adds nothing to the sign-in's
 * latency. A failure is reported without user data and never reaches the
 * sign-in.
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
        deviceKeyHash: hashSignInDevice(user.id, device),
        networkKeyHash: network === null ? null : hashSignInKey(user.id, 'network', network),
        now: request.occurredAt,
      });
      if (decision.kind !== 'new_device_new_network') return;
      await scheduleSecurityNotice(
        user,
        {
          type: 'new_sign_in',
          method,
          deviceKeyHash: decision.deviceKeyHash,
          networkKeyHash: decision.networkKeyHash,
        },
        request
      );
    } catch (error) {
      captureException(error, { tags: { source: 'sign_in_context_check' } });
    }
  });
}
