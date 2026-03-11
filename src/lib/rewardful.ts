import 'server-only';
import { cookies } from 'next/headers';

const REWARDFUL_COOKIE = 'rewardful_referral';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads the Rewardful referral ID (a UUID) from the cookie set by the client-side rw.js script. */
export async function getRewardfulReferral(): Promise<string | undefined> {
  try {
    const jar = await cookies();
    const value = jar.get(REWARDFUL_COOKIE)?.value;
    return value && UUID_RE.test(value) ? value : undefined;
  } catch (error) {
    console.warn('Failed to read rewardful referral cookie', error);
    return undefined;
  }
}
