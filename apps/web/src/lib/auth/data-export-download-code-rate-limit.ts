import 'server-only';
import { captureMessage } from '@sentry/nextjs';
import { checkRateLimit } from '@vercel/firewall';
import { headers } from 'next/headers';

/**
 * Vercel Firewall rate limit that caps download-code issuance. The rule lives in
 * the project's firewall configuration; `checkRateLimit` reports an unknown id as
 * "not rate limited", so the Sentry report below is the only signal that the rule
 * has gone missing.
 */
const DOWNLOAD_CODE_RATE_LIMIT_ID = 'data-export-download-code';

/**
 * Caps how often one account can have a download code emailed to it.
 *
 * The 60-second resend cooldown only spaces consecutive codes, and each new code
 * carries a fresh attempt budget, so this is what bounds a held session's total
 * guesses and the volume of mail it can aim at the account owner. Keyed by user id
 * rather than IP because that session is the threat, and unhashed because the id
 * is an opaque internal identifier, not PII like the email keying
 * `magic-link-email`.
 */
export async function isDataExportDownloadCodeRateLimited(kiloUserId: string): Promise<boolean> {
  const { rateLimited, error } = await checkRateLimit(DOWNLOAD_CODE_RATE_LIMIT_ID, {
    headers: await headers(),
    rateLimitKey: `${DOWNLOAD_CODE_RATE_LIMIT_ID}:${kiloUserId}`,
  });

  if (error === 'not-found') {
    captureMessage(`Firewall rate limit '${DOWNLOAD_CODE_RATE_LIMIT_ID}' is not configured`, {
      level: 'error',
      tags: { source: 'data_export_download_code' },
    });
  }

  return rateLimited;
}
