import { NEVERBOUNCE_API_KEY } from '@/lib/config.server';
import { captureMessage } from '@sentry/nextjs';

type NeverBounceResult = 'valid' | 'invalid' | 'disposable' | 'catchall' | 'unknown';

type NeverBounceResponse = {
  status: string;
  result: NeverBounceResult;
  flags: string[];
  suggested_correction: string;
  execution_time: number;
};

const BLOCKED_RESULTS = new Set<NeverBounceResult>(['invalid', 'disposable']);

// Domains where NeverBounce verification is skipped because their email
// infrastructure is known to cause false negatives (legitimate addresses
// reported as invalid). Apple iCloud is the primary offender.
const NEVERBOUNCE_BYPASS_DOMAINS = new Set(['icloud.com', 'me.com']);

function shouldBypassVerification(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain !== undefined && NEVERBOUNCE_BYPASS_DOMAINS.has(domain);
}

/**
 * Returns true if the email is safe to send to, false if it should be skipped.
 * If NeverBounce is not configured or the check fails, defaults to allowing the send.
 */
export async function verifyEmail(email: string): Promise<boolean> {
  if (!NEVERBOUNCE_API_KEY) {
    return true;
  }

  if (shouldBypassVerification(email)) {
    return true;
  }

  try {
    const url = new URL('https://api.neverbounce.com/v4.2/single/check');
    url.searchParams.set('key', NEVERBOUNCE_API_KEY);
    url.searchParams.set('email', email);

    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      console.warn(`[neverbounce] API returned ${response.status} for ${email}, allowing send`);
      return true;
    }

    const data: NeverBounceResponse = await response.json();

    if (data.status !== 'success') {
      console.warn(`[neverbounce] API returned status=${data.status} for ${email}, allowing send`);
      captureMessage(`NeverBounce API returned non-success status: ${data.status}`, {
        level: 'warning',
        tags: { source: 'neverbounce' },
        extra: { email, status: data.status },
      });
      return true;
    }

    if (BLOCKED_RESULTS.has(data.result)) {
      captureMessage(`Blocked email send to ${data.result} address`, {
        level: 'info',
        tags: { source: 'neverbounce', result: data.result },
        extra: { email, flags: data.flags, suggested_correction: data.suggested_correction },
      });
      console.log(`[neverbounce] Blocked send to ${email}: result=${data.result}`);
      return false;
    }

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`[neverbounce] Check failed for ${email}: ${errorMessage}, allowing send`);
    captureMessage('NeverBounce verification check failed', {
      level: 'warning',
      tags: { source: 'neverbounce' },
      extra: { email, error: errorMessage },
    });
    return true;
  }
}
