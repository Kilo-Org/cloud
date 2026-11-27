import {
  STS_WEB_COMPUTE_BALANCE_ALERT,
  webInternalCredential,
  type WebInternalAuthEnv,
} from '@kilocode/worker-utils/web-internal-credential';

export async function notifyOrganizationBalanceAlert(
  env: Pick<Cloudflare.Env, 'KILOCODE_BACKEND_BASE_URL' | 'INTERNAL_API_SECRET_PROD'> &
    WebInternalAuthEnv,
  organizationId: string
): Promise<void> {
  try {
    const credential = await webInternalCredential(env, STS_WEB_COMPUTE_BALANCE_ALERT, {
      header: 'X-Internal-Secret',
      secret: () => env.INTERNAL_API_SECRET_PROD.get(),
    });
    if (credential.kind === 'unavailable') {
      throw new Error('Internal service authentication is unavailable');
    }
    const response = await fetch(
      new URL('/api/internal/organizations/compute-balance-alert', env.KILOCODE_BACKEND_BASE_URL),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [credential.header]: credential.value },
        body: JSON.stringify({ organizationId }),
        signal: AbortSignal.timeout(3_000),
      }
    );
    await response.body?.cancel();
    if (!response.ok) throw new Error('Balance alert endpoint rejected the request');
  } catch {
    console.error(
      JSON.stringify({ event: 'organization_compute_balance_alert_failed', organizationId })
    );
  }
}
