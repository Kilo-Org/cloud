export async function notifyOrganizationBalanceAlert(
  env: Pick<Cloudflare.Env, 'KILOCODE_BACKEND_BASE_URL' | 'INTERNAL_API_SECRET_PROD'>,
  organizationId: string
): Promise<void> {
  try {
    const secret = await env.INTERNAL_API_SECRET_PROD.get();
    if (!secret) throw new Error('Internal service authentication is unavailable');
    const response = await fetch(
      new URL('/api/internal/organizations/compute-balance-alert', env.KILOCODE_BACKEND_BASE_URL),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
        body: JSON.stringify({ organizationId }),
        signal: AbortSignal.timeout(3_000),
      }
    );
    if (!response.ok) throw new Error('Balance alert endpoint rejected the request');
    await response.body?.cancel();
  } catch {
    console.error(
      JSON.stringify({ event: 'organization_compute_balance_alert_failed', organizationId })
    );
  }
}
