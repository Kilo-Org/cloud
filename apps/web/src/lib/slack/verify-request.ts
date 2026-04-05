import crypto from 'crypto';
import { SLACK_SIGNING_SECRET } from '@/lib/config.server';

/**
 * Verify that the request is coming from Slack using the signing secret.
 * See: https://api.slack.com/authentication/verifying-requests-from-slack
 */
export function verifySlackRequest(
  rawBody: string,
  timestamp: string | null,
  signature: string | null
): boolean {
  if (!timestamp || !signature || !SLACK_SIGNING_SECRET) {
    return false;
  }

  // Reject requests older than 5 minutes to prevent replay attacks
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    console.warn('[Slack] Request timestamp too old, possible replay attack');
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const mySignature =
    'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(sigBasestring).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
}
